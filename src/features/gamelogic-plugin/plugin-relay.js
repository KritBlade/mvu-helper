// gamelogic-plugin/plugin-relay.js — the host half of the plugin relay: the plugin ENGINE texts the
// shared Worker boots, and the relay PARTICIPANTS the turn runner calls on the relay fire. Both are handed
// to the logic-engine feature by REGISTRATION in src/index.js (P5) — that feature stays plugin-blind,
// this one supplies the vocabulary.
//
// Every decision here is pure: the lane-specific ones in plugin-relay-core.js, the op-shape ones in
// shared/json-patch-ops.js (the same module the PRE sim lane checks its ops with). This file reads state
// and performs what those decisions dictate.

import { getStandaloneLorebookEntries } from '../../sillytavern/lorebook.js';
import { parseMvuBlock } from '../../sillytavern/mvu-bridge.js';
import { refusedByPhrase, withoutMvuTransientKey } from '../../sillytavern/mvu-bridge-core.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { ARTIFACT_ROLES, findEntryByNeedle } from '../../shared/card-artifact-store.js';
import { getEngineScopeApi, engineIdentity, withLiveResolveSuppressed } from '../logic-engine/index.js';
import { readActiveExposesFrom } from '../gamelogic-pack/index.js';
import { readPluginRegistryFrom } from './gamelogic-plugin-activation.js';
import { PLUGIN_STATE_ROOT, pluginOwnRoot, pluginEngineComment, planExposesMatch } from './gamelogic-plugin-core.js';
import { opsOutcomeAfterApply, renderOpOutcome } from '../../shared/json-patch-ops.js';
import { planRelayPatch, buildRelayBlock, ownRootPointer, RELAY_EXPORT_NAME } from './plugin-relay-core.js';

const log = createModuleLog('gamelogic-plugin');

// The Worker scope one plugin's engine loads under. Namespaced so it can never collide with the game's
// scope (GAME_ENGINE_SCOPE = 'game', a shape this template cannot produce).
export function pluginEngineScope(id) {
    return 'plugin:' + String(id || '');
}

// ── the engine-text source ───────────────────────────────────────────────────

// Every installed plugin's hosted engine text, for the shared Worker's boot. Registered with the loader
// (registerPluginEngineSource) and called on every engine load, so a book that is not readable yet
// yields [] and the next load retries.
export async function readInstalledPluginEngines() {
    const entries = await getStandaloneLorebookEntries();
    if (entries === null) return [];
    const { registry, error } = readPluginRegistryFrom(entries);
    if (error || !registry.activePlugins.length) return [];
    const out = [];
    for (const rec of registry.activePlugins) {
        const entry = findEntryByNeedle(entries, pluginEngineComment(rec.id).toLowerCase());
        const code = entry ? String(entry.content || '') : '';
        if (!code.trim()) continue;             // a prompt-only plugin hosts nothing — not a fault
        // kind: the word the reload line groups these under (the loader never interprets it).
        out.push({ scope: pluginEngineScope(rec.id), code, kind: ARTIFACT_ROLES.plugin.engineLabel });
    }
    return out;
}

// ── the relay participants ───────────────────────────────────────────────────

// Everything the turn runner needs to run the plugin half of a relay fire, in INSTALL ORDER (the
// registry array is append-ordered). null when nothing would run, so the runner can skip silently.
// Registered with the turn runner (registerRelayParticipantsProvider).
export async function readRelayParticipants() {
    const entries = await getStandaloneLorebookEntries();
    if (entries === null) return null;
    const { registry, error } = readPluginRegistryFrom(entries);
    if (error || !registry.activePlugins.length) return null;

    // Roster: every installed plugin's id → own root, whether or not it hosts an engine. User-picked state
    // names defeat discovery by guessing, so the host hands the map to every resolver.
    const roster = {};
    for (const rec of registry.activePlugins) roster[rec.id] = pluginOwnRoot(rec.stateName);

    // The game engine's identity — the same { name, type, version, packId } renderPanel receives.
    const engine = engineIdentity();

    // Each plugin's declared interfaces, resolved against the active pack's map. The resolver receives
    // PATHS it can read `snapshot` with, never a neighbour's declarations.
    const activeExposes = readActiveExposesFrom(entries);

    const participants = [];
    for (const rec of registry.activePlugins) {
        const api = getEngineScopeApi(pluginEngineScope(rec.id));
        if (!api || typeof api[RELAY_EXPORT_NAME] !== 'function') continue;   // no engine, or it exports no resolver
        const { resolved } = planExposesMatch({ requires: rec.requires, optionalUses: rec.optionalUses, exposes: activeExposes });
        participants.push({ id: rec.id, resolve: buildRelayResolve(rec, api, roster, engine, resolved) });
    }
    return participants.length ? { participants } : null;
}

// One plugin's relay resolve: call its Worker scope with the relay ctx, then hand what came back to MVU
// as an `<UpdateVariable><JSONPatch>` block — THE SAME CALL the card's own POST bookkeeper makes
// (`parseMvuBlock`), so the ops are judged by the same Zod and persisted by the same fence + save.
//
// ⚠ THE PARSE IS SUPPRESSED. This runs INSIDE the VARIABLE_UPDATE_ENDED handler that fired the relay,
// and `parseMessage` emits that very event — unsuppressed, it would re-enter the runner for every plugin.
// Suppression (live-resolve-gate.js) is the mechanism for exactly this.
//
// Everything handed to the Worker crosses by structured clone, so live references are safe to pass.
function buildRelayResolve(rec, api, roster, engine, exposes) {
    const ownRoot = pluginOwnRoot(rec.stateName);
    const ownPointer = ownRootPointer(ownRoot);
    return async ({ mvuData, ops, dice, dicePools, mid, swipe }) => {
        const statData = mvuData && mvuData.stat_data;
        const platformRoot = (statData && typeof statData === 'object') ? statData[PLUGIN_STATE_ROOT] : null;
        const drawer = (platformRoot && typeof platformRoot === 'object') ? platformRoot[rec.stateName] : undefined;
        const result = await api[RELAY_EXPORT_NAME]({
            ownState: (drawer && typeof drawer === 'object') ? drawer : {},
            // Without MVU's transient key: a relay can run while MVU's update still holds `$internal`.
            snapshot: withoutMvuTransientKey(statData),
            ops: Array.isArray(ops) ? ops : [],
            // The dice receipt — everything dealt this generation, fresh and seeded pools alike. VERIFY-ONLY,
            // the same contract the game's RES lives by: a resolver never rolls a die its prose reports — it
            // deals in its OWN entry (MvuHelper.rollPool, its own pool name) and checks the claim here.
            // `null` = nothing dealt, verify nothing.
            dice: Array.isArray(dice) ? dice : null,
            // The same receipt per pool — { pool | hash, sides, dice } — so a resolver that deals more than
            // one die size checks a claim against the pool it came from. `null` exactly when `dice` is.
            dicePools: Array.isArray(dicePools) ? dicePools : null,
            // The plugin's OWN declarations resolved to the game's paths ({"cast@1": "Classmate"}); {} when
            // nothing matched. Read `snapshot` with these instead of guessing shapes.
            exposes: exposes || {},
            engine, roster, ownRoot, ownPointer,
            pluginVersion: rec.ver, mid, swipe,
        });
        // The resolver's own log lines, printed by the host under the resolver's name.
        for (const line of ((result && Array.isArray(result.log)) ? result.log : [])) {
            log.domain('pipeline', 'lifecycle', '"' + rec.id + '": ' + String(line));
        }
        const { ops: patchOps, dropped } = planRelayPatch(result && result.patches);
        // `reason` already names the op by index ("op #1 verb …"), so it is not re-prefixed here.
        for (const d of dropped) {
            log.warn('relay "' + rec.id + '": dropped ' + d.reason + ' (its siblings still went to MVU)');
        }
        if (!patchOps.length) {
            return { applied: false, summary: dropped.length ? 'every op was malformed — nothing sent' : 'wrote nothing' };
        }
        const applied = await withLiveResolveSuppressed(() => parseMvuBlock(buildRelayBlock(patchOps), mvuData, { writer: 'plugin:' + rec.id }));
        if (!applied) {
            log.warn('relay "' + rec.id + '": MVU applied NONE of its ' + patchOps.length
                + ' op(s) — every one was refused, or MVU is unavailable');
            return { applied: false, summary: 'MVU applied nothing' };
        }
        // A relay op is REFUSABLE exactly like the card's own — the SAME probe the PRE lane runs after its
        // own apply. Say which ones MVU turned down: a resolver that is never told keeps bookkeeping against
        // state it does not have. Compared by VALUE against the pre-apply state (`mvuData.stat_data`,
        // untouched because Mvu.parseMessage clones): a present path can still hold what was already
        // there, which is a refusal wearing a success's clothes.
        const outcomes = opsOutcomeAfterApply(mvuData.stat_data, applied.stat_data, patchOps);
        const refused = outcomes.filter((r) => r.state === 'refused' || r.state === 'absent');
        if (refused.length) {
            log.warn('relay "' + rec.id + '": ' + refused.length + ' op(s) did NOT take — '
                + refusedByPhrase(applied) + ': ' + refused.map(renderOpOutcome).join(' · '));
        }
        const landed = patchOps.length - refused.length;
        return {
            applied: true,
            statData: applied.stat_data,
            outcomes,
            summary: 'landed ' + landed + '/' + patchOps.length + ' op(s)' + (refused.length ? ' (' + refused.length + ' refused)' : ''),
        };
    };
}
