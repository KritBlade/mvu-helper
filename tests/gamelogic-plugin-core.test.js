// tests/gamelogic-plugin-core.test.js — the GameLogic Plugin lifecycle decisions. Each is a pure question
// about a registry, a binding, a comment or the card's schema, decided here rather than live, because a
// live-only claim would be untestable exactly where it matters (L6).

import { describe, it, expect } from 'vitest';
import {
    PLUGIN_STATE_ROOT, PLUGIN_TYPE,
    pluginRegistryComment, pluginRegistryMatch, parsePluginRegistry, buildPluginRegistryContent,
    findPluginRecord, isValidStateName, pluginOwnRoot, suggestStateName, decideStateName,
    callTag, substituteTokens, callsForPhase, planCallBindings, decidePluginInstall,
    planPluginEntries, planPluginEngineEntry, pluginEngineComment, planPluginPanelEntry,
    buildPluginRecord, upsertPluginRecord, removePluginRecord,
    reconcilePluginBindings, planBindingRebind, pluginRowView,
    planExposesMatch, reconcilePluginExposes,
    decidePluginSchemaInstall, SCHEMA_INSTALL_WRITE, SCHEMA_INSTALL_SKIP, SCHEMA_INSTALL_ASK, SCHEMA_INSTALL_BLOCKED,
    SCHEMA_ANSWER_REPLACE, SCHEMA_ANSWER_KEEP, pluginOwnsCardSchema, planPluginInstall, pluginInstallNotes,
} from '../src/features/gamelogic-plugin/gamelogic-plugin-core.js';
import { mergeInitSubtree } from '../src/shared/create-only-merge.js';
// IMPORTED, never re-spelled: the engine comment must match the needle the SWEEP really uses.
import { installedSweepNeedle, commentMatchesNeedle } from '../src/shared/card-artifact-store.js';
import { loreEntryMatchesCall } from '../src/features/small-llm/extra-llm-calls-core.js';

const plugin = (extra = {}) => ({
    format: '1.0', packType: 'plugin', id: 'worldsim', name: 'Living World', description: 'd',
    version: '1.0',
    entries: [
        { comment: '{PRE_CALL} worldsim request', content: 'read {OWN_ROOT}.ledger', order: 250 },
        { comment: '{POST_CALL} worldsim record', content: 'write to {OWN_ROOT}', order: 250 },
    ],
    ...extra,
});

const record = (extra = {}) => buildPluginRecord({
    plugin: plugin(), stateName: 'WorldSim', preCall: 'PRE', postCall: 'POST',
    installedComments: ['[GameLogicPlugin:worldsim] [PRE] worldsim request'],
    installedAt: '2026-08-16', ...extra,
});

const CALLS = [
    { name: 'PRE', phase: 'pre' },
    { name: 'Scout', phase: 'pre' },
    { name: 'POST', phase: 'post' },
];

describe('the registry — plural, and separate from the pack\'s', () => {
    it('names itself under the plugin prefix, not the pack\'s', () => {
        expect(pluginRegistryComment()).toBe('[GameLogicPlugin:Registry]');
        expect(pluginRegistryMatch()).toBe('[gamelogicplugin:registry]');
    });

    it('round-trips through build → parse', () => {
        const reg = { activePlugins: [record()] };
        const parsed = parsePluginRegistry(buildPluginRegistryContent(reg));
        expect(parsed.activePlugins).toHaveLength(1);
        expect(parsed.activePlugins[0].id).toBe('worldsim');
        expect(parsed.activePlugins[0].boundCalls).toEqual({ pre: 'PRE', post: 'POST' });
    });

    it('an EMPTY body is no plugins — a list, never null', () => {
        expect(parsePluginRegistry('# header only\n').activePlugins).toEqual([]);
    });

    it('THROWS on malformed JSON — read as "nothing installed" the next sweep would be destructive', () => {
        expect(() => parsePluginRegistry('{ not json')).toThrow();
    });

    it('THROWS when activePlugins is not an array', () => {
        expect(() => parsePluginRegistry('{"activePlugins":{"worldsim":{}}}')).toThrow(/ARRAY/);
    });

    it('removing one plugin leaves every other record intact', () => {
        const reg = { activePlugins: [record(), record({ plugin: plugin({ id: 'weather' }), stateName: 'Weather' })] };
        const after = removePluginRecord(reg, 'worldsim');
        expect(after.activePlugins.map((r) => r.id)).toEqual(['weather']);
        expect(findPluginRecord(after, 'weather').stateName).toBe('Weather');
    });

    it('upsert replaces by id rather than appending a duplicate', () => {
        const reg = upsertPluginRecord({ activePlugins: [record()] }, record({ plugin: plugin({ version: '2.0' }) }));
        expect(reg.activePlugins).toHaveLength(1);
        expect(reg.activePlugins[0].ver).toBe('2.0');
    });

    // A record carries BINDINGS and what was written — never a state shape: the plugin creates its own
    // keys in an empty drawer, so there is nothing to seed.
    it('records no state shape at all, whatever the file carried', () => {
        const rec = buildPluginRecord({ plugin: plugin({ init: { ledger: { Tokyo: 1 } } }), stateName: 'WorldSim' });
        expect(rec.init).toBeUndefined();
        expect(Object.keys(rec).sort()).toEqual(['boundCalls', 'description', 'format', 'id', 'installedAt', 'installedComments', 'keepsCardSchema', 'name', 'optionalUses', 'requires', 'schemaOwned', 'stateName', 'ver']);
        // schemaOwned and keepsCardSchema are the schema ANSWERS, not shape: whether this install wrote
        // the card's Scheme script, and whether the user chose to keep the card's own.
        expect(rec.schemaOwned).toBe(false);
        expect(rec.keepsCardSchema).toBe(false);
    });

    it('records the "keep the card\'s schema" answer, and it survives the registry round trip', () => {
        const rec = buildPluginRecord({ plugin: plugin(), stateName: 'WorldSim', keepsCardSchema: true });
        expect(parsePluginRegistry(buildPluginRegistryContent({ activePlugins: [rec] })).activePlugins[0].keepsCardSchema).toBe(true);
    });

    // A hand-edited registry may carry `init`; parsing must DROP it rather than round-trip a field nothing reads.
    it('drops an `init` on parse instead of carrying it forward', () => {
        const raw = JSON.stringify({ activePlugins: [{ id: 'worldsim', stateName: 'WorldSim', init: { ledger: {} } }] });
        expect(parsePluginRegistry(raw).activePlugins[0].init).toBeUndefined();
    });

    // Identity beside ownership: the release export reads the record after the library file is gone, so
    // what the plugin is CALLED must survive both the build and the read-normalize.
    it('records plugin identity and round-trips it through the registry', () => {
        const rec = buildPluginRecord({ plugin: plugin({ builtWith: 'hand 1.0' }), stateName: 'WorldSim' });
        expect(rec.name).toBe(plugin().name);
        expect(rec.description).toBe(plugin().description);
        expect(rec.format).toBe('1.0');
        expect(rec.builtWith).toBe('hand 1.0');
        const back = parsePluginRegistry(buildPluginRegistryContent(upsertPluginRecord(null, rec))).activePlugins[0];
        expect(back.name).toBe(rec.name);
        expect(back.builtWith).toBe('hand 1.0');
    });
    it('a record without identity parses with empty identity and NO builtWith key — absent is not declared', () => {
        const raw = JSON.stringify({ activePlugins: [{ id: 'worldsim', stateName: 'WorldSim' }] });
        const back = parsePluginRegistry(raw).activePlugins[0];
        expect(back.name).toBe('');
        expect(back.format).toBe('');
        expect('builtWith' in back).toBe(false);
    });
});

describe('the state drawer — created host-side, never a declared shape', () => {
    // The SECOND plugin lands on a card where the root, and another plugin's PLAYED subtree, already
    // exist. This models exactly what the chat-load pass hands mergeInitSubtree.
    it('a second plugin gains its drawer while the first keeps its played state', () => {
        const statData = {
            World: { Date: '2026-04-08' },
            [PLUGIN_STATE_ROOT]: { Rain: { Days: ['2026-04-07'], Total: 1 } },
        };
        const drawers = { Rain: {}, Weather: {} };          // both installed plugins, every pass
        const res = mergeInitSubtree(statData, { [PLUGIN_STATE_ROOT]: drawers });

        expect(res.changed).toBe(true);
        expect(res.written).toEqual([PLUGIN_STATE_ROOT + '.Weather']);   // ONLY the new one
        expect(statData[PLUGIN_STATE_ROOT].Rain).toEqual({ Days: ['2026-04-07'], Total: 1 });
        expect(statData[PLUGIN_STATE_ROOT].Weather).toEqual({});
        expect(statData.World).toEqual({ Date: '2026-04-08' });          // nothing outside the root
    });

    it('a pass with nothing new writes NOTHING — no churn on every chat load', () => {
        const statData = { [PLUGIN_STATE_ROOT]: { Rain: { Total: 3 } } };
        const res = mergeInitSubtree(statData, { [PLUGIN_STATE_ROOT]: { Rain: {} } });
        expect(res.changed).toBe(false);
        expect(statData[PLUGIN_STATE_ROOT].Rain).toEqual({ Total: 3 });
    });
});

describe('the own root — the fence, not a style rule', () => {
    it('accepts one plain segment', () => {
        expect(isValidStateName('WorldSim')).toBe(true);
        expect(isValidStateName('world_sim2')).toBe(true);
    });

    it('refuses anything that could widen the write scope past its own subtree', () => {
        for (const bad of ['World.Sim', '..', 'a/b', '', '2fast', 'a b', null]) {
            expect(isValidStateName(bad)).toBe(false);
        }
    });

    it('builds the root under the platform namespace', () => {
        expect(pluginOwnRoot('WorldSim')).toBe(PLUGIN_STATE_ROOT + '.WorldSim');
    });

    it('suggests a legal prefill from any id', () => {
        expect(suggestStateName('worldsim')).toBe('worldsim');
        expect(suggestStateName('world-sim')).toBe('world_sim');
        expect(suggestStateName('2fast')).toBe('Plugin_2fast');
        expect(suggestStateName('')).toBe('Plugin');
    });

    it('refuses a name another plugin already owns — two plugins in one subtree overwrite each other', () => {
        const reg = { activePlugins: [record()] };
        const v = decideStateName({ requested: 'WorldSim', registry: reg, selfId: 'weather' });
        expect(v.ok).toBe(false);
        expect(v).toMatchObject({ problem: 'taken', name: 'WorldSim', takenBy: 'worldsim' });
        expect(v.reason).toMatch(/already the state root of plugin "worldsim"/);
    });

    it('is NOT a collision with itself — reinstall and upgrade keep their own name', () => {
        const reg = { activePlugins: [record()] };
        expect(decideStateName({ requested: 'WorldSim', registry: reg, selfId: 'worldsim' }).ok).toBe(true);
    });

    it('names the fence in the refusal, so a dot is not a mystery', () => {
        const v = decideStateName({ requested: 'World.Sim', registry: { activePlugins: [] } });
        expect(v.ok).toBe(false);
        expect(v).toMatchObject({ problem: 'invalid', name: 'World.Sim' });
        expect(v.reason).toMatch(/outside its own subtree/);
    });

});

describe('tokens — presence IS the declaration', () => {
    it('substitutes a call into the BRACKETED tag the router matches', () => {
        expect(callTag('PRE')).toBe('[PRE]');
        expect(substituteTokens('{PRE_CALL} request', { preCall: 'PRE' })).toBe('[PRE] request');
    });

    it('substitutes every occurrence, in comment and content alike', () => {
        expect(substituteTokens('{OWN_ROOT}.a and {OWN_ROOT}.b', { ownRoot: 'GameLogicPlugin.W' }))
            .toBe('GameLogicPlugin.W.a and GameLogicPlugin.W.b');
    });

    it('LEAVES an unbound token alone rather than blanking it — a blank routes to nothing, invisibly', () => {
        expect(substituteTokens('{POST_CALL} record', { preCall: 'PRE' })).toBe('{POST_CALL} record');
    });

    it('touches nothing else', () => {
        expect(substituteTokens('{{user}} said {name}', { preCall: 'PRE', ownRoot: 'R' })).toBe('{{user}} said {name}');
    });
});

describe('call bindings — the dialog is derived, never guessed', () => {
    it('lists only the phase\'s own calls', () => {
        expect(callsForPhase(CALLS, 'pre')).toEqual(['PRE', 'Scout']);
        expect(callsForPhase(CALLS, 'post')).toEqual(['POST']);
    });

    it('preselects when exactly one call fits — zero ceremony', () => {
        const p = planCallBindings({ needs: { pre: false, post: true }, availableCalls: CALLS });
        expect(p.preselect.post).toBe('POST');
        expect(p.choices.post).toEqual(['POST']);
    });

    it('does NOT preselect when the user has a real choice', () => {
        const p = planCallBindings({ needs: { pre: true, post: false }, availableCalls: CALLS });
        expect(p.preselect.pre).toBe('');
        expect(p.choices.pre).toEqual(['PRE', 'Scout']);
    });

    it('BLOCKS a needed phase the profile cannot satisfy, naming what to do', () => {
        const p = planCallBindings({ needs: { pre: true, post: true }, availableCalls: [{ name: 'PRE', phase: 'pre' }] });
        expect(p.blocked).toHaveLength(1);
        expect(p.blocked[0]).toMatch(/needs a POST call.*no POST call is configured/s);
    });

    it('asks nothing for a phase the plugin never declared', () => {
        const p = planCallBindings({ needs: { pre: false, post: false }, availableCalls: [] });
        expect(p.blocked).toEqual([]);
        expect(p.choices).toEqual({ pre: [], post: [] });
    });
});

describe('install decision', () => {
    const reg = { activePlugins: [record()] };

    it('refuses outside a chat — every write here edits that card\'s book', () => {
        expect(decidePluginInstall({ isCardOpen: false, isChatStarted: false, areEntriesReadable: true, plugin: plugin(), registry: reg }).action).toBe('no-chat');
    });

    // Same split as the pack lane: a book that has not answered is not a missing chat, and it must
    // never be read as an empty registry (which would decide 'install' over a plugin already there).
    it('an unreadable book refuses on its own terms, not as "no chat"', () => {
        const d = decidePluginInstall({ isCardOpen: true, isChatStarted: true, areEntriesReadable: false, plugin: plugin({ id: 'weather' }), registry: reg });
        expect(d.action).toBe('card-unreadable');
        expect(d.reasons.join(' ')).not.toContain('open a chat');
    });

    // The lobby: a placeholder chat with no readable book must read as "no chat", not as a wait.
    it('the LOBBY is no-chat even though its placeholder chat has messages', () => {
        const d = decidePluginInstall({ isCardOpen: false, isChatStarted: true, areEntriesReadable: false, plugin: plugin(), registry: reg });
        expect(d.action).toBe('no-chat');
        expect(d.reasons.join(' ')).not.toContain('could not be read yet');
    });

    it('install when the id is not on the card', () => {
        expect(decidePluginInstall({ isCardOpen: true, isChatStarted: true, areEntriesReadable: true, plugin: plugin({ id: 'weather' }), registry: reg }).action).toBe('install');
    });

    it('upgrade / repair / downgrade by version, and a downgrade names both versions', () => {
        expect(decidePluginInstall({ isCardOpen: true, isChatStarted: true, areEntriesReadable: true, plugin: plugin({ version: '2.0' }), registry: reg }).action).toBe('upgrade');
        expect(decidePluginInstall({ isCardOpen: true, isChatStarted: true, areEntriesReadable: true, plugin: plugin({ version: '1.0' }), registry: reg }).action).toBe('repair');
        const down = decidePluginInstall({ isCardOpen: true, isChatStarted: true, areEntriesReadable: true, plugin: plugin({ version: '0.9' }), registry: reg });
        expect(down.action).toBe('downgrade');
        expect(down.reasons[0]).toBe('library v0.9 is older than the installed v1.0');
        expect(down).toMatchObject({ installedVersion: '1.0', libraryVersion: '0.9' });
    });
});

describe('the entries an install writes', () => {
    const bindings = { preCall: 'PRE', postCall: 'POST', ownRoot: 'GameLogicPlugin.WorldSim' };

    it('prefixes for ownership AND substitutes for routing — an entry needs both', () => {
        const plan = planPluginEntries(plugin(), bindings);
        expect(plan.entries[0].comment).toBe('[GameLogicPlugin:worldsim] [PRE] worldsim request');
        expect(plan.installedComments).toEqual(plan.entries.map((e) => e.comment));
    });

    it('substitutes inside CONTENT too', () => {
        const plan = planPluginEntries(plugin(), bindings);
        expect(plan.entries[0].content).toBe('read GameLogicPlugin.WorldSim.ledger');
    });

    it('passes every other field through verbatim and strips uid', () => {
        const p = plugin({ entries: [{ comment: 'x', content: 'y', order: 250, position: 'at_depth', depth: 3, uid: 9 }] });
        const e = planPluginEntries(p, bindings).entries[0];
        expect(e).toMatchObject({ order: 250, position: 'at_depth', depth: 3 });
        expect(e.uid).toBeUndefined();
    });
});

describe('binding drift', () => {
    it('finds a binding whose call the user renamed away, and offers the survivors', () => {
        const reg = { activePlugins: [record({ preCall: 'Ghost', postCall: 'POST' })] };
        const found = reconcilePluginBindings(reg, CALLS);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ id: 'worldsim', phase: 'pre', expected: 'Ghost' });
        expect(found[0].candidates).toEqual(['PRE', 'Scout']);
        expect(found[0].reason).toMatch(/route to nothing until it is rebound/);
    });

    it('says so when the phase has no call at all — that is fixed in Extra LLM Calls, not by rebinding', () => {
        const reg = { activePlugins: [record({ preCall: 'Ghost', postCall: '' })] };
        expect(reconcilePluginBindings(reg, [{ name: 'POST', phase: 'post' }])[0].reason)
            .toMatch(/no PRE call is configured at all/);
    });

    it('finds POST drift too — both phases are checked, not just the first', () => {
        const reg = { activePlugins: [record({ preCall: 'PRE', postCall: 'Gone' })] };
        const found = reconcilePluginBindings(reg, CALLS);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ phase: 'post', expected: 'Gone' });
    });

    it('reports BOTH phases when both have drifted', () => {
        const reg = { activePlugins: [record({ preCall: 'Ghost', postCall: 'Gone' })] };
        expect(reconcilePluginBindings(reg, CALLS).map((f) => f.phase)).toEqual(['pre', 'post']);
    });

    it('is silent when every binding still resolves', () => {
        expect(reconcilePluginBindings({ activePlugins: [record()] }, CALLS)).toEqual([]);
    });

    it('ignores a phase the plugin never bound', () => {
        expect(reconcilePluginBindings({ activePlugins: [record({ postCall: '' })] }, CALLS)).toEqual([]);
    });

    // MUTATION TARGET: by the shared state alone a plugin reaching no prompt reads Installed.
    it('drift replaces Installed with Drift — otherwise a plugin reaching no prompt looks healthy', () => {
        const drift = reconcilePluginBindings({ activePlugins: [record({ preCall: 'Ghost' })] }, CALLS);
        const view = pluginRowView({ record: record({ preCall: 'Ghost' }), libraryCopy: { name: 'Living World' }, led: 'green', bindingDrift: drift });
        expect(view.pills).toEqual([{ text: 'Drift', status: 'warning' }]);
        expect(view.sub.slice(-1)).toEqual([{ name: drift[0].reason }]);
        expect(view.rebindPhases).toEqual(['pre']);
        expect(pluginRowView({ record: record(), libraryCopy: { name: 'Living World' }, led: 'green' }).pills).toEqual([{ text: 'Installed', status: 'success' }]);
    });

    it('but never masks another state — missing pieces stay on the row beside Drift', () => {
        const view = pluginRowView({ record: record(), libraryCopy: { name: 'Living World' }, led: 'red', missing: ['[x]'], exposesDrift: [{ id: 'worldsim', reason: 'gone' }] });
        expect(view.pills).toEqual([{ text: 'Pieces missing', status: 'danger' }, { text: 'Drift', status: 'warning' }]);
        expect(view.rebindPhases).toEqual([]);
    });

    it('an optionalUses finding is the plugin’s own choice, not drift', () => {
        const view = pluginRowView({ record: record(), libraryCopy: { name: 'Living World' }, led: 'green', exposesDrift: [{ id: 'worldsim', reason: 'runs without it', degradedOnly: true }] });
        expect(view.pills).toEqual([{ text: 'Installed', status: 'success' }]);
    });

    it('the row: name, version, id, state root and flavor, then the bound calls', () => {
        const view = pluginRowView({ record: record({ postCall: '' }), led: 'amber' });
        expect(view.name).toBe('worldsim');
        expect(view.sub[0]).toEqual({ parts: [{ name: 'v1.0 · ' }, { code: 'worldsim' }, { name: ' · ' }, { code: 'GameLogicPlugin.WorldSim' }, { name: ' · ' }, { text: 'standalone' }] });
        expect(view.sub[1]).toEqual({ text: 'Bound calls', name: 'PRE → PRE' });
        expect(view.pills).toEqual([{ text: 'No library copy', status: 'warning' }]);
    });

    it('a card that lost its schema says so, as drift Repair fixes', () => {
        const view = pluginRowView({ record: record(), libraryCopy: { name: 'Living World' }, led: 'green', hasCardLostSchema: true });
        expect(view.pills).toEqual([{ text: 'Drift', status: 'warning' }]);
        expect(view.sub.slice(-1)).toEqual([{ text: "This card has no schema now, so the plugin's drawer accepts nothing. Repair writes the plugin's own." }]);
    });

    it('rebind rewrites only the comments carrying the old tag, and updates the record', () => {
        const rec = record({
            installedComments: ['[GameLogicPlugin:worldsim] [PRE] req', '[GameLogicPlugin:worldsim] [POST] rec'],
        });
        const { renames, updated } = planBindingRebind(rec, 'pre', 'Scout');
        expect(renames).toEqual([{
            from: '[GameLogicPlugin:worldsim] [PRE] req',
            to: '[GameLogicPlugin:worldsim] [Scout] req',
        }]);
        expect(updated.boundCalls).toEqual({ pre: 'Scout', post: 'POST' });
        expect(updated.installedComments[1]).toBe('[GameLogicPlugin:worldsim] [POST] rec');
    });
});

describe('the engine entry', () => {
    it('the comment is a SECTION entry — the section name inside the ownership bracket', () => {
        expect(pluginEngineComment('worldsim')).toBe('[GameLogicPlugin:worldsim:Engine]');
    });

    // The sweep is IMPORTED, never re-typed: an assertion against a hand-typed needle proves only what the
    // author believes the sweep is. When builder and sweep drift, a hosted engine reads "missing".
    it('sweepNeedleMatchesEngineComment — the REAL sweep catches it, so uninstall needs no new machinery', () => {
        expect(commentMatchesNeedle(pluginEngineComment('worldsim'), installedSweepNeedle(PLUGIN_TYPE, 'worldsim'))).toBe(true);
    });

    it('and still refuses a NEIGHBOURING id — the boundary after the id is what makes that true', () => {
        const sweep = installedSweepNeedle(PLUGIN_TYPE, 'rpg');
        expect(commentMatchesNeedle(pluginEngineComment('rpg'), sweep)).toBe(true);
        expect(commentMatchesNeedle(pluginEngineComment('rpg-artific'), sweep)).toBe(false);
        expect(commentMatchesNeedle('[GameLogicPlugin:rpg-artific] entry', sweep)).toBe(false);
    });

    // small-llm routes an entry to a call by finding the exact token `[<callName>]` anywhere in its
    // comment; `:Engine]` is not that token, so a call named "Engine" never binds the engine entry.
    it('carries no call tag — the routing namespace is untouched', () => {
        expect(pluginEngineComment('worldsim')).not.toContain('[Engine]');
        expect(loreEntryMatchesCall({ comment: pluginEngineComment('worldsim') }, 'Engine')).toBe(false);
    });

    it('plans a SILENT entry from the file\'s engine section — enabled:false is load-bearing', () => {
        const entry = planPluginEngineEntry(plugin({ engine: 'module.exports = { resolveRelay: () => ({}) };' }));
        expect(entry.comment).toBe('[GameLogicPlugin:worldsim:Engine]');
        expect(entry.content).toContain('resolveRelay');
        expect(entry.enabled).toBe(false);
        expect(entry.type).toBe('constant');
    });

    it('no engine section (or a blank one) plans NOTHING — a prompt-lane-only plugin is not a fault', () => {
        expect(planPluginEngineEntry(plugin())).toBeNull();
        expect(planPluginEngineEntry(plugin({ engine: '   ' }))).toBeNull();
        expect(planPluginEngineEntry(null)).toBeNull();
    });
});

// The blind string broker. It knows no interface vocabulary; both sides declared strings and it compares
// them, which is exactly what makes these tests writable without a consumer.
describe('planExposesMatch — requires refuse, optionalUses run without, matches resolve', () => {
    const EXPOSES = { 'cast@1': 'CastRoot', 'calendar@1': 'Derived.Clock' };

    it('a matched requires resolves to the game\'s own path', () => {
        const m = planExposesMatch({ requires: ['cast@1'], exposes: EXPOSES });
        expect(m.blocked).toEqual([]);
        expect(m.resolved).toEqual({ 'cast@1': 'CastRoot' });
    });

    it('an unmatched requires BLOCKS, naming the interface and what IS exposed', () => {
        const m = planExposesMatch({ requires: ['inventory@1'], exposes: EXPOSES });
        expect(m.blocked).toHaveLength(1);
        expect(m.blocked[0]).toMatch(/requires "inventory@1"/);
        expect(m.blocked[0]).toMatch(/cast@1, calendar@1/);
        expect(m.resolved).toEqual({});
    });

    it('an unmatched optionalUses is listed by NAME and never blocks', () => {
        const m = planExposesMatch({ optionalUses: ['inventory@1'], exposes: EXPOSES });
        expect(m.blocked).toEqual([]);
        expect(m.degraded).toEqual(['inventory@1']);
    });

    it('no active pack (empty exposes) blocks a requires and says so', () => {
        const m = planExposesMatch({ requires: ['cast@1'], exposes: {} });
        expect(m.blocked[0]).toMatch(/no pack is active, or it exposes nothing/);
    });

    it('declaring nothing matches anything — {} in, {} out, no findings', () => {
        expect(planExposesMatch({ exposes: EXPOSES })).toEqual({ resolved: {}, blocked: [], degraded: [] });
    });
});

describe('reconcilePluginExposes — the chat-load drift half', () => {
    const EXPOSES = { 'cast@1': 'CastRoot' };

    it('a recorded requires no longer exposed is a finding naming the plugin', () => {
        const reg = { activePlugins: [{ ...record(), requires: ['cast@1'] }] };
        const f = reconcilePluginExposes(reg, {}, null);
        expect(f).toHaveLength(1);
        expect(f[0].id).toBe('worldsim');
        expect(f[0].reason).toMatch(/requires "cast@1"/);
        expect(f[0].degradedOnly).toBeUndefined();
    });

    it('an unmatched optionalUses is marked degradedOnly — warn material, never amber', () => {
        const reg = { activePlugins: [{ ...record(), optionalUses: ['cast@1'] }] };
        const f = reconcilePluginExposes(reg, {}, null);
        expect(f).toHaveLength(1);
        expect(f[0].degradedOnly).toBe(true);
        expect(f[0].reason).toMatch(/optionally uses "cast@1".*runs without it/);
    });

    it('a resolved path ABSENT from live stat_data is a finding — declared, matched, pointing at nothing', () => {
        const reg = { activePlugins: [{ ...record(), requires: ['cast@1'] }] };
        const f = reconcilePluginExposes(reg, EXPOSES, { OtherRoot: {} });
        expect(f).toHaveLength(1);
        expect(f[0].reason).toMatch(/ABSENT from live stat_data/);
    });

    it('a resolved path PRESENT in stat_data yields zero findings — the healthy case is silent', () => {
        const reg = { activePlugins: [{ ...record(), requires: ['cast@1'] }] };
        expect(reconcilePluginExposes(reg, EXPOSES, { CastRoot: {} })).toEqual([]);
    });

    it('without statData the live half stands down instead of accusing every path', () => {
        const reg = { activePlugins: [{ ...record(), requires: ['cast@1'] }] };
        expect(reconcilePluginExposes(reg, EXPOSES, null)).toEqual([]);
    });

    it('a record with no requires recorded yields nothing — declares nothing, drifts nothing', () => {
        const reg = { activePlugins: [record()] };
        expect(reconcilePluginExposes(reg, {}, null)).toEqual([]);
    });

    it('requires and optionalUses RECORD from the file and round-trip through the registry', () => {
        const rec = buildPluginRecord({ plugin: plugin({ requires: ['cast@1'], optionalUses: ['calendar@1'] }), stateName: 'WorldSim' });
        expect(rec.requires).toEqual(['cast@1']);
        expect(rec.optionalUses).toEqual(['calendar@1']);
        const parsed = parsePluginRegistry(buildPluginRegistryContent({ activePlugins: [rec] }));
        expect(parsed.activePlugins[0].requires).toEqual(['cast@1']);
        expect(parsed.activePlugins[0].optionalUses).toEqual(['calendar@1']);
    });
});

// The panel declaration is hosted on the card exactly as the engine text is: a silent entry under a
// reserved comment the plugin sweep catches without new machinery.
describe('the panel entry', () => {
    const PANEL = { kind: 'slot-list', format: '1.0', title: 'Outfits', tabs: [{ id: 't', name: 'T', blocks: [] }] };

    const panelComment = (id) => planPluginPanelEntry(plugin({ id, panel: PANEL })).comment;

    it('the comment is a SECTION entry beside the engine\'s — one builder, two section names', () => {
        expect(panelComment('worldsim')).toBe('[GameLogicPlugin:worldsim:Panel]');
        expect(panelComment('worldsim')).not.toContain('[Panel]');
    });

    it('the REAL sweep catches it — uninstall needs ZERO new machinery for the panel', () => {
        const sweep = installedSweepNeedle(PLUGIN_TYPE, 'worldsim');
        expect(commentMatchesNeedle(panelComment('worldsim'), sweep)).toBe(true);
        expect(commentMatchesNeedle(panelComment('worldsim-extra'), sweep)).toBe(false);
    });

    it('plans a SILENT entry carrying the WHOLE declaration — the renderer is handed the artifact, not a summary', () => {
        const entry = planPluginPanelEntry(plugin({ panel: PANEL }));
        expect(entry.comment).toBe('[GameLogicPlugin:worldsim:Panel]');
        expect(entry.enabled).toBe(false);
        expect(entry.type).toBe('constant');
        expect(JSON.parse(entry.content)).toEqual(PANEL);
    });

    it('no panel section (or a non-object one) plans NOTHING — a plugin with no display is not a fault', () => {
        expect(planPluginPanelEntry(plugin())).toBeNull();
        expect(planPluginPanelEntry(plugin({ panel: 'x' }))).toBeNull();
        expect(planPluginPanelEntry(plugin({ panel: [] }))).toBeNull();
        expect(planPluginPanelEntry(null)).toBeNull();
    });
});

// Same pass-through as the pack lane: this lane refuses for the same reason and must give the same
// specific instruction (card-access-core, cardUnreadableReason).
describe('decidePluginInstall — the unreadable reason is the SPECIFIC one', () => {
    const unreadable = (bookBinding, bookName) => decidePluginInstall({
        isCardOpen: true, isChatStarted: true, areEntriesReadable: false,
        bookBinding, bookName,
        plugin: { packType: 'plugin', id: 'p', version: '1' }, registry: { activePlugins: [] },
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

    it('a book that exists but has not answered keeps the honest wait', () => {
        expect(unreadable('loading').reasons[0]).toContain('Retry in a moment');
    });
});

describe("rule 7 — the plugin's own schema, and which card needs it", () => {
    const MINE = 'registerMvuSchema(z.looseObject({ GameLogicPlugin: z.record(z.string(), z.any()) }));';
    const decide = (extra) => decidePluginSchemaInstall({ pluginSchemaText: MINE, scriptApiUp: true, ...extra });
    const owned = (schema, extra = {}) => buildPluginRecord({ plugin: plugin({ schema }), stateName: 'WorldSim', schemaOwned: true, ...extra });

    it('a card with NO schema gets it — and the toast says so', () => {
        const v = decide({ cardSchemaText: null });
        expect(v.action).toBe(SCHEMA_INSTALL_WRITE);
        expect(v.reason).toContain('freeze');
        expect(v.note).toBe('added its schema (the card had none)');
    });

    it('an empty script counts as no schema, not as one to ask about', () => {
        expect(decide({ cardSchemaText: '   ' }).action).toBe(SCHEMA_INSTALL_WRITE);
    });

    it("a GameLogic Pack's schema is never touched, and no question is asked about it", () => {
        const v = decide({ cardSchemaText: 'the game schema', packOwnsSchema: true });
        expect(v.action).toBe(SCHEMA_INSTALL_SKIP);
        expect(v.reason).toContain('GameLogic Pack');
        expect(v.note).toBe('');
    });

    it('MUTATION TARGET — pack ownership outranks the answer: a "replace" still skips', () => {
        // A WRITE here would let one click discard the game's whole schema. The question exists for a
        // schema no pack owns; it is not an override for this one.
        expect(decide({ cardSchemaText: 'the game schema', packOwnsSchema: true, answer: SCHEMA_ANSWER_REPLACE }).action)
            .toBe(SCHEMA_INSTALL_SKIP);
    });

    it('an identical schema already on the card is a no-op, not a question', () => {
        expect(decide({ cardSchemaText: MINE }).action).toBe(SCHEMA_INSTALL_SKIP);
    });

    it('MUTATION TARGET — an UNOWNED, different schema ASKS when nothing is answered yet', () => {
        expect(decide({ cardSchemaText: 'somebody else' }).action).toBe(SCHEMA_INSTALL_ASK);
    });

    it('answered "replace" writes it, and the toast says the card\'s schema was replaced', () => {
        const v = decide({ cardSchemaText: 'somebody else', answer: SCHEMA_ANSWER_REPLACE });
        expect(v.action).toBe(SCHEMA_INSTALL_WRITE);
        expect(v.note).toBe("replaced the card's schema");
    });

    it('answered "keep" skips it, and the toast says the card kept its own', () => {
        const v = decide({ cardSchemaText: 'somebody else', answer: SCHEMA_ANSWER_KEEP });
        expect(v.action).toBe(SCHEMA_INSTALL_SKIP);
        expect(v.note).toBe("kept the card's schema");
    });

    it('MUTATION TARGET — a RECORDED "keep" is reused: an upgrade or a dev-loop re-apply asks nothing again', () => {
        const rec = buildPluginRecord({ plugin: plugin({ schema: MINE }), stateName: 'WorldSim', keepsCardSchema: true });
        expect(decide({ cardSchemaText: 'somebody else', record: rec }).action).toBe(SCHEMA_INSTALL_SKIP);
    });

    it('MUTATION TARGET — the schema THIS plugin wrote earlier is replaced by its new version without asking', () => {
        const v = decide({ cardSchemaText: 'v1 of mine', record: owned('v1 of mine') });
        expect(v.action).toBe(SCHEMA_INSTALL_WRITE);
        expect(v.note).toBe('updated its own schema');
    });

    it('a schema someone REPLACED since this plugin wrote its own is not the plugin\'s any more — it asks', () => {
        expect(decide({ cardSchemaText: 'somebody else', record: owned('v1 of mine') }).action).toBe(SCHEMA_INSTALL_ASK);
    });

    it('MUTATION TARGET — a detached script API BLOCKS, it does not read as "no schema here"', () => {
        // An empty answer from an API that is not attached is "could not look", and treating it as
        // "nothing there" is exactly how an overwrite gets through unasked.
        const v = decidePluginSchemaInstall({ pluginSchemaText: MINE, cardSchemaText: null, scriptApiUp: false });
        expect(v.action).toBe(SCHEMA_INSTALL_BLOCKED);
    });

    it('MUTATION TARGET — a plugin with no schema is a caller that skipped validation: it throws, never writes an empty script', () => {
        expect(() => decidePluginSchemaInstall({ pluginSchemaText: '', cardSchemaText: null, scriptApiUp: true })).toThrow(/validate/);
        expect(() => decidePluginSchemaInstall({ pluginSchemaText: '  ', cardSchemaText: 'x', scriptApiUp: true })).toThrow();
    });

    it('the schema is RECORDED even when it is not written — the export owes a valid file', () => {
        // Install skips writing on any card that already has a schema, so the card is not a copy this
        // can be read back from. Without the record, export(install(A)) produces a file rule 7 refuses.
        const rec = buildPluginRecord({ plugin: plugin({ schema: MINE }), stateName: 'WorldSim' });
        expect(rec.schema).toBe(MINE);
        expect(rec.schemaOwned).toBe(false);
        expect(parsePluginRegistry(JSON.stringify({ activePlugins: [rec] })).activePlugins[0].schema).toBe(MINE);
    });
});

describe('pluginOwnsCardSchema — ownership is the flag AND the text still on the card', () => {
    const rec = (extra) => buildPluginRecord({ plugin: plugin({ schema: 'S1' }), stateName: 'WorldSim', ...extra });

    it('owned only while the card carries exactly what this plugin wrote', () => {
        expect(pluginOwnsCardSchema(rec({ schemaOwned: true }), 'S1')).toBe(true);
        expect(pluginOwnsCardSchema(rec({ schemaOwned: true }), 'S2')).toBe(false);
    });

    it('MUTATION TARGET — never owned without the flag, without a record, or against an empty card', () => {
        expect(pluginOwnsCardSchema(rec({ schemaOwned: false }), 'S1')).toBe(false);
        expect(pluginOwnsCardSchema(null, 'S1')).toBe(false);
        expect(pluginOwnsCardSchema(rec({ schemaOwned: true }), '')).toBe(false);
        expect(pluginOwnsCardSchema(buildPluginRecord({ plugin: plugin(), stateName: 'W', schemaOwned: true }), '')).toBe(false);
    });
});

// The install decides EVERYTHING before its first write: an open schema question means no plan at all, so
// nothing lands on the card until the user answers.
describe('planPluginInstall — the whole write set, or nothing', () => {
    const bindings = { preCall: 'PRE', postCall: 'POST', ownRoot: 'GameLogicPlugin.WorldSim' };
    const full = plugin({ schema: 'S', engine: 'module.exports = {};', panel: { kind: 'slot-list', tabs: [] } });

    it('MUTATION TARGET — an open schema question plans NO writes and names the surface it asks about', () => {
        const plan = planPluginInstall({ plugin: full, bindings, schemaVerdict: { action: SCHEMA_INSTALL_ASK, reason: 'r' }, cardSchemaText: 'CARD' });
        expect(plan.ready).toBe(false);
        expect(plan.action).toBe('needs-adopt');
        expect(plan.entries).toBeUndefined();
        expect(plan.adoptable).toHaveLength(1);
        expect(plan.adoptable[0]).toEqual({ text: 'The "Scheme" script, card → plugin:', name: '4 B → 1 B' });
    });

    it('a detached script API plans no writes either', () => {
        const plan = planPluginInstall({ plugin: full, bindings, schemaVerdict: { action: SCHEMA_INSTALL_BLOCKED, reason: 'r' } });
        expect(plan).toEqual({ ready: false, action: 'schema-unreadable', reasons: ['r'] });
    });

    it('a final verdict plans every entry, the engine and panel sections, and whether the schema is written', () => {
        const write = planPluginInstall({ plugin: full, bindings, schemaVerdict: { action: SCHEMA_INSTALL_WRITE } });
        expect(write.ready).toBe(true);
        expect(write.writesSchema).toBe(true);
        expect(write.entries).toHaveLength(2);
        expect(write.installedComments).toEqual([
            '[GameLogicPlugin:worldsim] [PRE] worldsim request',
            '[GameLogicPlugin:worldsim] [POST] worldsim record',
            '[GameLogicPlugin:worldsim:Engine]',
            '[GameLogicPlugin:worldsim:Panel]',
        ]);
        expect(planPluginInstall({ plugin: full, bindings, schemaVerdict: { action: SCHEMA_INSTALL_SKIP } }).writesSchema).toBe(false);
    });
});

describe('pluginInstallNotes — what the success toast tells the user', () => {
    it('names the matched interfaces, the ones it runs without, the schema and the panel', () => {
        expect(pluginInstallNotes({
            exposesResolved: { 'cast@1': 'Classmate' }, exposesDegraded: ['calendar@1'],
            schemaNote: "kept the card's schema", hostsPanel: true,
        })).toEqual([
            'uses cast@1 → Classmate',
            'calendar@1 not exposed — runs without it',
            "kept the card's schema",
            "its panel is in the side panel (the chevron at the chat's right edge)",
        ]);
    });

    it('says nothing when there is nothing to say', () => {
        expect(pluginInstallNotes({})).toEqual([]);
        expect(pluginInstallNotes()).toEqual([]);
    });
});
