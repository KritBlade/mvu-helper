// gamelogic-plugin/gamelogic-plugin-activation.js — the per-CARD half of the plugin lifecycle: install /
// upgrade / uninstall, the drawer, and drift reconciliation.
//
// Every DECISION is pure and lives in gamelogic-plugin-core.js; this file reads state, calls the
// decision, and performs the writes it dictates — the same split as the pack's activation.
//
// Install HOSTS two of the file's sections on the card under reserved comments: the `engine` text
// ([GameLogicPlugin:<id>:Engine], booted in the shared Worker so its resolveRelay answers the relay
// fire) and the `panel` declaration ([GameLogicPlugin:<id>:Panel], rendered by `features/side-panel/`,
// format in devdoc/side-panel-format.md). `requires` are matched against the active game's `exposes` when
// the install is prepared; unmatched `optionalUses` let it run without them, and say so.

import {
    upsertLorebookEntryFields,
    deleteLorebookEntriesByNeedle,
    flushLorebookWrites,
    getStandaloneLorebookEntries,
} from '../../sillytavern/lorebook.js';
import { readCardAccess } from '../../sillytavern/card-access.js';
import { cardAccessProblem, cardUnreadableReason } from '../../sillytavern/card-access-core.js';
import { latestMsgId, getMvu, saveMessageMvuData } from '../../sillytavern/mvu-bridge.js';
import {
    SCRIPT_SCOPE_CHARACTER, getScriptTrees, upsertScript, deleteScript, isScriptApiAvailable,
} from '../../sillytavern/tavern-script.js';
import { findScriptByName } from '../../sillytavern/tavern-script-core.js';
import { writeJudgeOf, JUDGE_MVU_DERIVED } from '../../sillytavern/mvu-bridge-core.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { tailMessagesCarryingVariables } from '../../shared/generation-floor.js';
import { syncCardData } from '../card-sync/index.js';
import { getExtraLlmCallsProfile } from '../small-llm/index.js';
import {
    judgePackFile, finishArtifactExport, readLibraryPack, declaredCallBindings, readActiveExposesFrom,
    packOwnsCardSchema, SCHEMA_SCRIPT_NAME,
} from '../gamelogic-pack/index.js';
import { loadLogicEngine, readMenuEngineExportsInWorker } from '../logic-engine/index.js';
import { mergeInitSubtree } from '../../shared/create-only-merge.js';
import {
    findEntryByNeedle, commentsMatchingNeedle,
    installedSweepNeedle, preDeleteNeedles, uninstallExactness, registryRemovalOutcome, PLUGIN_FLAVOR_GAME_BOUND,
} from '../../shared/card-artifact-store.js';
import {
    PLUGIN_TYPE, PLUGIN_STATE_ROOT,
    pluginRegistryComment, pluginRegistryMatch, parsePluginRegistry, buildPluginRegistryContent,
    findPluginRecord, decideStateName, decidePluginInstall, planCallBindings, planPluginInstall,
    buildPluginRecord, upsertPluginRecord, removePluginRecord,
    reconcilePluginBindings, planBindingRebind, pluginOwnRoot, suggestStateName, callsForPhase,
    planExposesMatch, reconcilePluginExposes, pluginInstallNotes, pluginOwnsCardSchema,
    buildPluginExportFile,
    decidePluginSchemaInstall, SCHEMA_ANSWER_KEEP,
} from './gamelogic-plugin-core.js';

const log = createModuleLog('gamelogic-plugin');

// ── card-state reads ─────────────────────────────────────────────────────────

// The card's plugin registry, or an empty one when absent. A MALFORMED registry is reported and
// returned as { error } so every caller stands down — read as "no plugins installed" it would make the
// next uninstall sweep destructive off a typo.
export function readPluginRegistryFrom(entries) {
    const entry = findEntryByNeedle(entries, pluginRegistryMatch());
    if (!entry) return { registry: { activePlugins: [] }, error: '' };
    try { return { registry: parsePluginRegistry(entry.content), error: '' }; }
    catch (e) {
        log.error('the ' + pluginRegistryComment() + ' entry is malformed — plugin operations stand down:', e);
        return { registry: null, error: 'the ' + pluginRegistryComment() + ' entry is malformed (see console) — fix or delete it first' };
    }
}

// The user's configured Extra LLM Calls, as [{ name, phase }] — the ONLY source of call names. Read
// through the profile rather than passed in, so a caller cannot accidentally supply a stale list.
export function availableCalls() {
    const elc = getExtraLlmCallsProfile();
    return (Array.isArray(elc.calls) ? elc.calls : [])
        .filter((c) => c && String(c.name || ''))
        .map((c) => ({ name: String(c.name), phase: c.phase === 'post' ? 'post' : 'pre', enabled: c.enabled !== false }));
}

export async function readCardPluginState() {
    // The three access facts come from the ONE shared read (card-access.js); this lane only adds its
    // own registry parse.
    const { entries, isCardOpen, isChatStarted, areEntriesReadable, canOperateOnCard, bookBinding, bookName } = await readCardAccess();
    const { registry, error } = entries === null ? { registry: { activePlugins: [] }, error: '' } : readPluginRegistryFrom(entries);
    return { isCardOpen, isChatStarted, areEntriesReadable, canOperateOnCard, bookBinding, bookName, entries, registry, registryError: error };
}

// Everything the install dialog needs before it can ask anything: the validated file, what it needs
// bound, what the profile can offer, and the prefilled state name. Returns { ok, reasons, … } so a
// refusal is named at the point the user asked, not after they filled a form in.
export async function preparePluginInstall(id) {
    const text = await readLibraryPack(PLUGIN_TYPE, id);
    if (text === null) return { ok: false, reasons: ['"' + id + '" is not in the library (or the library book is not readable)'] };

    // Judged AGAIN — the library entry is hand-editable, so trusting the import-time judgement would let
    // an edit skip every rule.
    const file = await judgePackFile(text, { readMenuEngine: readMenuEngineExportsInWorker });
    if (!file.ok) return { ok: false, reasons: file.errors };
    const plugin = file.pack;
    if (plugin.packType !== PLUGIN_TYPE) return { ok: false, reasons: ['"' + id + '" is a ' + plugin.packType + ' pack, not a plugin'] };

    const state = await readCardPluginState();
    if (state.registryError) return { ok: false, reasons: [state.registryError] };

    const decision = decidePluginInstall({
        isCardOpen: state.isCardOpen, isChatStarted: state.isChatStarted,
        areEntriesReadable: state.areEntriesReadable, bookBinding: state.bookBinding, bookName: state.bookName,
        plugin, registry: state.registry,
    });
    if (decision.action === 'no-chat' || decision.action === 'card-unreadable' || decision.action === 'invalid') {
        return { ok: false, reasons: decision.reasons };
    }

    const needs = declaredCallBindings(plugin);         // token presence IS the declaration
    const bindings = planCallBindings({ needs, availableCalls: availableCalls() });
    if (bindings.blocked.length) return { ok: false, reasons: bindings.blocked };

    // The interface match, at the point the user asked: an unmatched `requires` refuses HERE, named,
    // before a form is filled in; an unmatched `optionalUses` proceeds, and the install says so.
    const exposesMatch = planExposesMatch({
        requires: plugin.requires, optionalUses: plugin.optionalUses,
        exposes: readActiveExposesFrom(state.entries),
    });
    if (exposesMatch.blocked.length) return { ok: false, reasons: exposesMatch.blocked.map((b) => 'this ' + PLUGIN_FLAVOR_GAME_BOUND + ' plugin ' + b) };
    // The plugin's own declared choice: the install message names it, so the log needs no warning.
    for (const name of exposesMatch.degraded) {
        log.lifecycle('"' + plugin.id + '" optionally uses "' + name + '", which the active GameLogic Pack does not expose — it runs without it');
    }

    // An upgrade or repair REUSES the recorded answers: the user re-picks nothing.
    const existing = findPluginRecord(state.registry, plugin.id);
    return {
        ok: true, reasons: decision.reasons, action: decision.action, plugin, needs,
        installedVersion: decision.installedVersion, libraryVersion: decision.libraryVersion,
        exposesResolved: exposesMatch.resolved,
        exposesDegraded: exposesMatch.degraded,
        choices: bindings.choices,
        preselect: existing
            ? { pre: existing.boundCalls.pre, post: existing.boundCalls.post }
            : bindings.preselect,
        stateName: existing ? existing.stateName : suggestStateName(plugin.id),
        stateNameLocked: Boolean(existing),   // moving a live subtree is not an install's job
        schemaRemovals: file.schemaRemovals,   // what the schema allow-list took out of plugin.schema
    };
}

// ── install / upgrade ────────────────────────────────────────────────────────

// Install a library plugin onto the current card with the answers the dialog collected.
// `schemaAnswer` is the schema question's answer ('replace' | 'keep'), '' when not asked yet: an install
// that needs it returns { action: 'needs-adopt', adoptable } having written NOTHING.
// Returns { ok, action, reasons, notes?, adoptable? }.
export async function installPlugin(id, { stateName, preCall = '', postCall = '', confirmDowngrade = false, schemaAnswer = '' } = {}) {
    const prep = await preparePluginInstall(id);
    if (!prep.ok) return { ok: false, action: 'refused', reasons: prep.reasons };
    const { plugin, action } = prep;
    if (action === 'downgrade' && !confirmDowngrade) return { ok: false, action, reasons: prep.reasons };

    const state = await readCardPluginState();
    if (state.registryError) return { ok: false, action: 'registry-malformed', reasons: [state.registryError] };

    const nameVerdict = decideStateName({ requested: stateName, registry: state.registry, selfId: plugin.id });
    if (!nameVerdict.ok) return { ok: false, action: 'state-name', reasons: [nameVerdict.reason] };

    // A declared need with no answer would install entries routed to nothing.
    for (const phase of ['pre', 'post']) {
        const picked = phase === 'pre' ? preCall : postCall;
        if (prep.needs[phase] && !picked) {
            return { ok: false, action: 'unbound', reasons: ['this plugin needs a ' + phase.toUpperCase()
                + ' call (its entries carry {' + phase.toUpperCase() + '_CALL}) and none was chosen'] };
        }
    }

    const ownRoot = pluginOwnRoot(stateName);
    const existing = findPluginRecord(state.registry, plugin.id);

    // EVERY read and decision before the first write: the schema verdict completes the plan, and an
    // install whose schema question is open writes nothing at all (planPluginInstall).
    const scriptApiUp = isScriptApiAvailable();
    const cardSchemaScript = scriptApiUp
        ? findScriptByName(await getScriptTrees(SCRIPT_SCOPE_CHARACTER), SCHEMA_SCRIPT_NAME)
        : null;
    const cardSchemaText = cardSchemaScript ? String(cardSchemaScript.content || '') : '';
    const schemaVerdict = decidePluginSchemaInstall({
        pluginSchemaText: plugin.schema,
        cardSchemaText,
        packOwnsSchema: packOwnsCardSchema(state.entries),
        scriptApiUp,
        answer: schemaAnswer,
        record: existing,
    });
    const plan = planPluginInstall({ plugin, bindings: { preCall, postCall, ownRoot }, schemaVerdict, cardSchemaText });
    if (!plan.ready) return { ok: false, action: plan.action, reasons: plan.reasons, adoptable: plan.adoptable || [] };

    const summary = [];
    // An install over an existing record is NEVER uninstall + install. Delete exactly what was recorded,
    // plus the same needle sweep uninstall runs, so an entry renamed between versions cannot survive under
    // its old name and a hand-edited comment cannot escape the replacement.
    if (existing) {
        const needles = preDeleteNeedles(existing, PLUGIN_TYPE, plugin.id);
        let removed = 0;
        for (const comment of needles.recorded) removed += await deleteLorebookEntriesByNeedle(comment);
        const strays = await deleteLorebookEntriesByNeedle(needles.sweep);
        if (strays) {
            log.warn('' + action + ' swept ' + strays + ' entr' + (strays === 1 ? 'y' : 'ies')
                + ' carrying this plugin\'s prefix that the registry never recorded — a hand-edited comment, or a'
                + ' crashed earlier install. They were replaced, not kept.');
        }
        removed += strays;
        if (removed) summary.push('replaced ' + removed + ' prior entr' + (removed === 1 ? 'y' : 'ies'));
    }

    for (const entry of plan.entries) {
        const wrote = await upsertLorebookEntryFields(String(entry.comment).toLowerCase(), entry);
        if (!wrote) {
            return { ok: false, action, reasons: ['entry "' + entry.comment + '" could not be written — the card book is'
                + ' unavailable; the plugin is PARTIALLY installed (re-install to repair)'] };
        }
    }
    summary.push(plan.entries.length + ' entr' + (plan.entries.length === 1 ? 'y' : 'ies'));

    // The ENGINE entry: the file's `engine` text, hosted on the card so the shared Worker boots it per
    // chat with the library file gone. Recorded like every other entry, so upgrade replaces it and the
    // uninstall exactness count agrees.
    if (plan.engineEntry) {
        const wrote = await upsertLorebookEntryFields(plan.engineEntry.comment.toLowerCase(), plan.engineEntry);
        if (!wrote) {
            return { ok: false, action, reasons: ['the engine entry "' + plan.engineEntry.comment + '" could not be written — the plugin is PARTIALLY installed (re-install to repair)'] };
        }
        summary.push('engine text hosted');
    }

    // The PANEL entry: the side-panel slot declaration, hosted whole and recorded like the engine entry.
    if (plan.panelEntry) {
        const wrote = await upsertLorebookEntryFields(plan.panelEntry.comment.toLowerCase(), plan.panelEntry);
        if (!wrote) {
            return { ok: false, action, reasons: ['the panel entry "' + plan.panelEntry.comment + '" could not be written — the plugin is PARTIALLY installed (re-install to repair)'] };
        }
        summary.push('panel declaration hosted');
    }

    // The SCHEMA, written only where the verdict says the card needs it.
    if (plan.writesSchema) {
        const wrote = await upsertScript(SCRIPT_SCOPE_CHARACTER, SCHEMA_SCRIPT_NAME, {
            content: plugin.schema,
            enabled: true,
            info: 'Installed by MVU Helper — GameLogic Plugin "' + plugin.id + '" v' + (plugin.version || '?')
                + ' schema: declares ' + PLUGIN_STATE_ROOT + ' open (rule 7).',
        });
        if (!wrote) return { ok: false, action, reasons: ['the "' + SCHEMA_SCRIPT_NAME + '" script could not be written — the plugin is PARTIALLY installed (re-install to repair)'] };
        summary.push('schema ' + plugin.schema.length + ' B');
        // What the schema allow-list removed is written nowhere, so it is said here, line by line.
        for (const r of prep.schemaRemovals) {
            log.warn('"' + plugin.id + '" schema line ' + r.line + ' removed (not on the schema allow-list): ' + r.what + ' — ' + r.why);
        }
    } else {
        log.lifecycle('schema not written for "' + plugin.id + '" — ' + schemaVerdict.reason);
    }

    // Registry LAST among the book writes, so a crash mid-install leaves a sweep-recoverable card rather
    // than a registry claiming pieces that were never written.
    const record = buildPluginRecord({
        plugin, stateName, preCall, postCall,
        installedComments: plan.installedComments,
        schemaOwned: plan.writesSchema || pluginOwnsCardSchema(existing, cardSchemaText),
        keepsCardSchema: !plan.writesSchema && (schemaAnswer === SCHEMA_ANSWER_KEEP || Boolean(existing && existing.keepsCardSchema)),
        installedAt: new Date().toISOString().slice(0, 10),
    });
    const nextRegistry = upsertPluginRecord(state.registry, record);
    const wroteReg = await upsertLorebookEntryFields(pluginRegistryMatch(), {
        comment: pluginRegistryComment(),
        content: buildPluginRegistryContent(nextRegistry),
        enabled: false, type: 'constant', keys: [],
    });
    if (!wroteReg) return { ok: false, action, reasons: ['the plugin registry could not be written — the plugin is PARTIALLY installed (re-install to repair)'] };

    // Create the plugin's own drawer in the CURRENT chat, so `{OWN_ROOT}` is readable from the first turn
    // rather than only after the plugin's first successful write.
    await syncCardData();

    await flushLorebookWrites();   // this operation spans the card book and the library

    // The Worker's text set changed — reboot it with the new engine (swapping any text restarts the
    // Worker and reloads all of them). Install runs from a click, so no generation is in flight;
    // `force` because the game text may be byte-identical while the plugin set is not.
    if (plan.engineEntry) await loadLogicEngine({ force: true });

    const notes = pluginInstallNotes({
        exposesResolved: prep.exposesResolved, exposesDegraded: prep.exposesDegraded,
        schemaNote: schemaVerdict.note, hostsPanel: Boolean(plan.panelEntry),
    });
    // SURFACED, never repaired (L7): a card judged by MVU's own derived schema freezes the drawer, and
    // nothing here can substitute for a running Zod schema. An install that just wrote the plugin's own
    // schema is the exception — that schema takes over once the chat reloads and the next reply parses.
    if (!plan.writesSchema && cardJudgesWithDerivedSchema()) {
        log.warn('"' + plugin.id + '" installed, but this card runs NO Zod schema — its MVU blob still carries'
            + " MVU's own derived schema. That schema freezes every object to the keys it held when MVU derived it, so this"
            + " plugin's drawer (" + ownRoot + ') accepts nothing after the first write and its relay ops will be refused.'
            + ' Give the card a Zod schema that declares ' + PLUGIN_STATE_ROOT + ' open');
    }
    log.lifecycle('' + action + ' "' + plugin.id + '" v' + (plugin.version || '?')
        + ' — ' + summary.join(' · ') + ' · root ' + ownRoot
        + ' · calls ' + (preCall ? 'pre=' + preCall : '') + (preCall && postCall ? ' ' : '') + (postCall ? 'post=' + postCall : '')
        + (notes.length ? ' · ' + notes.join(' · ') : ''));
    // The install toast reports removals only from a schema this install actually wrote.
    return { ok: true, action, reasons: [], notes, schemaRemovals: plan.writesSchema ? prep.schemaRemovals : [] };
}

// ── uninstall ────────────────────────────────────────────────────────────────

// Remove one plugin. `purgeState` deletes its own-root subtree; the default KEEPS it, because a reinstall
// should find a game where it left it. Nothing outside `GameLogicPlugin.<stateName>` is ever touched, and
// there is no branch that could reach further.
// Returns { ok, removedEntries, purged, exactness, reasons }.
export async function uninstallPlugin(id, { purgeState = false } = {}) {
    const state = await readCardPluginState();
    const access = cardAccessProblem(state);
    if (access === 'card-unreadable') return { ok: false, reasons: [cardUnreadableReason({ binding: state.bookBinding, bookName: state.bookName, suffix: '(Removing what cannot be listed is how residue is left behind.)' })] };
    if (access) return { ok: false, reasons: ['open a chat first — uninstall edits that card\'s worldbook'] };
    if (state.registryError) return { ok: false, reasons: [state.registryError] };
    const record = findPluginRecord(state.registry, id);
    if (!record) return { ok: false, reasons: ['"' + id + '" is not installed on this card'] };

    // The schema check needs the script API; ask before anything is deleted, so a refusal leaves the
    // install whole.
    if (record.schemaOwned && !isScriptApiAvailable()) {
        return { ok: false, reasons: ['this plugin installed the "' + SCHEMA_SCRIPT_NAME + '" script, and the TavernHelper'
            + ' script API is not attached yet — retry in a moment so the uninstall can be exact'] };
    }

    // Exactness — the record vs the book, compared BEFORE deleting so both sides can be named.
    const sweep = installedSweepNeedle(PLUGIN_TYPE, id);
    const swept = commentsMatchingNeedle(state.entries, sweep);
    const exactness = uninstallExactness(record.installedComments, swept);
    if (!exactness.agree) {
        log.warn('uninstall count mismatch: recorded-but-missing: ['
            + exactness.onlyInRecord.join(', ') + '] · found-but-unrecorded: [' + exactness.onlyInSweep.join(', ') + ']'
            + ' — deleting the union; nothing is silently kept');
    }

    const removedEntries = await deleteLorebookEntriesByNeedle(sweep);

    const nextRegistry = removePluginRecord(state.registry, id);
    // The registry is NOT part of the sweep above. Whether its entry is there is read BEFORE deleting:
    // 0 removed means "failed" only if there was something to remove (registryRemovalOutcome).
    const registryNeedle = pluginRegistryMatch();
    const registryWasPresent = commentsMatchingNeedle(state.entries, registryNeedle).length > 0;
    let registryNote = '';
    if (nextRegistry.activePlugins.length) {
        const wroteReg = await upsertLorebookEntryFields(registryNeedle, {
            comment: pluginRegistryComment(),
            content: buildPluginRegistryContent(nextRegistry),
            enabled: false, type: 'constant', keys: [],
        });
        if (!wroteReg) {
            return { ok: false, reasons: ['the plugin registry could not be updated — "' + id + '" entries were removed but its record remains'] };
        }
        registryNote = ' · registry updated (' + nextRegistry.activePlugins.length + ' plugin(s) left)';
    } else {
        const outcome = registryRemovalOutcome({
            wasPresent: registryWasPresent,
            removedCount: await deleteLorebookEntriesByNeedle(registryNeedle),
        });
        if (outcome === 'failed') {
            log.warn('the plugin registry entry could NOT be removed after uninstalling the last'
                + ' plugin — it is still on the card, listing nothing. A later install will read it. Remove'
                + ' "' + pluginRegistryComment() + '" by hand, or reinstall and uninstall once the lorebook API is back.');
        }
        registryNote = outcome === 'removed' ? ' · registry removed (that was the last plugin)'
            : outcome === 'failed' ? ' · REGISTRY NOT REMOVED (warned above)' : '';
    }

    // The schema goes ONLY while the card still carries exactly what this plugin wrote
    // (pluginOwnsCardSchema). A schema from a GameLogic Pack, another plugin or the card itself stays:
    // deleting it would take the card's whole validation with it.
    let schemaNote = '';
    if (record.schemaOwned) {
        const script = findScriptByName(await getScriptTrees(SCRIPT_SCOPE_CHARACTER), SCHEMA_SCRIPT_NAME);
        if (!pluginOwnsCardSchema(record, script ? script.content : '')) {
            schemaNote = ' · schema kept (the card\'s "' + SCHEMA_SCRIPT_NAME + '" is no longer the one this plugin installed)';
        } else if (await deleteScript(SCRIPT_SCOPE_CHARACTER, SCHEMA_SCRIPT_NAME)) {
            schemaNote = ' · schema removed';
        } else {
            log.warn('the "' + SCHEMA_SCRIPT_NAME + '" script this plugin installed could NOT be'
                + ' removed — it is still on the card, declaring ' + PLUGIN_STATE_ROOT + ' open for a plugin that is gone.'
                + ' Harmless, but delete it by hand if the card is going out.');
            schemaNote = ' · SCHEMA NOT REMOVED (warned above)';
        }
    }

    const purged = purgeState ? await purgeOwnRoot(record.stateName) : false;
    await flushLorebookWrites();

    // A plugin that hosted an engine leaves the Worker: any text change restarts the Worker, and a scope
    // whose plugin is gone must not keep answering relays.
    if (record.installedComments.some((c) => c.toLowerCase().includes(':engine]'))) {
        await loadLogicEngine({ force: true });
    }

    // The count names what the ARTIFACT's needle removed; the registry and the schema ride their own
    // clauses, so the number adds up against what the book lost.
    log.lifecycle('uninstalled "' + id + '" v' + record.ver + ' — ' + removedEntries + ' entries'
        + registryNote + schemaNote + ' · '
        + (purged ? 'purged ' + pluginOwnRoot(record.stateName) : 'kept ' + pluginOwnRoot(record.stateName) + ' (reinstall finds it)')
        + ' · nothing outside that root was touched');
    return { ok: true, removedEntries, purged, exactness, reasons: [] };
}

// Delete `GameLogicPlugin.<stateName>` from the live save. Scoped by construction: it addresses ONE key
// inside the platform's own root and can express nothing wider.
async function purgeOwnRoot(stateName) {
    const Mvu = getMvu();
    const id = latestMsgId();
    if (!Mvu || typeof Mvu.getMvuData !== 'function' || typeof Mvu.replaceMvuData !== 'function' || id < 0) {
        log.warn('purge requested but MVU is not reachable — ' + pluginOwnRoot(stateName)
            + ' was LEFT IN PLACE. Uninstall of the entries still completed.');
        return false;
    }
    try {
        const data = Mvu.getMvuData({ type: 'message', message_id: id });
        const root = data && data.stat_data && data.stat_data[PLUGIN_STATE_ROOT];
        if (!root || root[stateName] === undefined) {
            log.child('purge').verbose('' + pluginOwnRoot(stateName) + ' held no state — nothing to delete');
            return false;
        }
        delete root[stateName];
        await saveMessageMvuData(data, id, { writer: 'plugin-activation' });
        return true;
    } catch (e) {
        log.warn('purge of ' + pluginOwnRoot(stateName) + ' failed — the state was left in place:', e);
        return false;
    }
}

// Does this card run a Zod schema at all? A card judged by MVU's own derived schema freezes a plugin's
// drawer to the keys it held when MVU derived it — for a drawer created empty, none, ever. The plugin
// installs perfectly and then writes nothing: the one failure that looks like a broken plugin and is not.
//
// ⚠ MESSAGE 1 AT THE EARLIEST. The Zod sentinel is stamped by an UPDATE, so message 0's blob carries MVU's
// derived schema on a healthy Zod card too; reading it there would warn about every card on its first
// turn. An inconclusive read answers "fine" — a vague answer beats a false accusation.
function cardJudgesWithDerivedSchema() {
    const Mvu = getMvu();
    const id = latestMsgId();
    if (!Mvu || typeof Mvu.getMvuData !== 'function' || id < 1) return false;
    try {
        return writeJudgeOf(Mvu.getMvuData({ type: 'message', message_id: id })) === JUDGE_MVU_DERIVED;
    } catch (e) {
        log.child('cardJudgesWithDerivedSchema').verbose('blob not readable (' + (e && e.message || e) + ')');
        return false;
    }
}

// Does the open card carry a "Scheme" script at all? { readable, hasSchema } — `readable` is false while
// the TavernHelper script API is not attached, and then nothing may be concluded. A plugin on a card with
// no schema at all has a frozen drawer (MVU's derived schema), so its row offers Repair, which writes the
// plugin's own (decidePluginSchemaInstall).
export async function readCardSchemaPresence() {
    if (!isScriptApiAvailable()) return { readable: false, hasSchema: false };
    const script = findScriptByName(await getScriptTrees(SCRIPT_SCOPE_CHARACTER), SCHEMA_SCRIPT_NAME);
    return { readable: true, hasSchema: Boolean(script && String(script.content || '').trim()) };
}

// The latest message's live stat_data, or null when MVU / the chat is not readable — the LED needs it so
// a resolved-but-absent interface path can show amber, not only warn in the console.
export function readLatestStatData() {
    const Mvu = getMvu();
    const id = latestMsgId();
    if (!Mvu || typeof Mvu.getMvuData !== 'function' || id < 0) return null;
    try {
        const data = Mvu.getMvuData({ type: 'message', message_id: id });
        return (data && data.stat_data && typeof data.stat_data === 'object') ? data.stat_data : null;
    } catch (e) {
        log.child('readLatestStatData').verbose('not readable yet (' + (e && e.message || e) + ')');
        return null;
    }
}

// ── binding drift ────────────────────────────────────────────────────────────

// Rebind one plugin's phase to a different call: rewrite the recorded comments mechanically, then the
// record. Follows the rename rather than re-deriving from the file, which may no longer be in the library.
export async function rebindPluginCall(id, phase, newCall) {
    const state = await readCardPluginState();
    const access = cardAccessProblem(state);
    if (access === 'card-unreadable') return { ok: false, reasons: [cardUnreadableReason({ binding: state.bookBinding, bookName: state.bookName })] };
    if (access) return { ok: false, reasons: ['open a chat first — rebinding edits that card\'s worldbook'] };
    if (state.registryError) return { ok: false, reasons: [state.registryError] };
    const record = findPluginRecord(state.registry, id);
    if (!record) return { ok: false, reasons: ['"' + id + '" is not installed on this card'] };
    if (!callsForPhase(availableCalls(), phase).includes(String(newCall))) {
        return { ok: false, reasons: ['"' + newCall + '" is not a configured ' + String(phase).toUpperCase() + ' call'] };
    }

    const { renames, updated } = planBindingRebind(record, phase, newCall);
    for (const { from, to } of renames) {
        const wrote = await upsertLorebookEntryFields(from.toLowerCase(), { comment: to });
        if (!wrote) return { ok: false, reasons: ['entry "' + from + '" could not be renamed — rebind stopped part-way; re-run it'] };
    }
    const wroteReg = await upsertLorebookEntryFields(pluginRegistryMatch(), {
        comment: pluginRegistryComment(),
        content: buildPluginRegistryContent(upsertPluginRecord(state.registry, updated)),
        enabled: false, type: 'constant', keys: [],
    });
    if (!wroteReg) return { ok: false, reasons: ['the plugin registry could not be updated — the entries were renamed but the record still names the old call'] };
    await flushLorebookWrites();

    log.lifecycle('rebound "' + id + '" ' + String(phase).toUpperCase() + ' call: "'
        + record.boundCalls[phase] + '" → "' + newCall + '" — ' + renames.length + ' entr'
        + (renames.length === 1 ? 'y' : 'ies') + ' renamed');
    return { ok: true, renamed: renames.length, reasons: [] };
}

// ── the per-chat-load pass ───────────────────────────────────────────────────

// Registered with card-sync, so it rides the SAME hooks and the SAME single write as every other pass.
// Two jobs, both create-only or read-only:
//   • make sure every installed plugin's DRAWER exists — an empty `GameLogicPlugin.<stateName>` object;
//   • WARN on drift — a renamed call leaves entries routed to nothing, and an interface the game stopped
//     exposing leaves a plugin reading nothing; nothing else in the system would ever say so.
//
// The drawer is EMPTY on purpose. A plugin declares no state shape anywhere: what it keeps, at what depth,
// and when it starts keeping it are the plugin's business, and an OPEN declaration of `GameLogicPlugin`
// in the card's Zod schema (the game's, or the plugin's own) lets it create those keys as it goes. This
// pass only guarantees the container is there, so `{OWN_ROOT}` resolves to something readable from the
// first turn.
//
// ⚠ An empty drawer is only safe while the card's Zod schema is RUNNING. Without it, MVU's own
// shape-derived schema freezes every object to the keys it held at derivation, so the drawer accepts
// nothing. That is a broken card, not a reason to seed a shape here: guessing keys for a plugin that
// declares none would put the platform in the business of knowing what a plugin keeps.
export function gameLogicPluginSyncPass(statData, entries) {
    const { registry, error } = readPluginRegistryFrom(entries);
    if (error) return { changed: false, reports: [] };
    const list = registry.activePlugins;
    if (!list.length) return { changed: false, reports: [] };

    const drawers = {};
    for (const rec of list) if (rec.stateName) drawers[rec.stateName] = {};
    const res = mergeInitSubtree(statData, { [PLUGIN_STATE_ROOT]: drawers });
    const changed = res.changed;
    if (changed) {
        log.lifecycle('created ' + res.written.length + ' state drawer'
            + (res.written.length === 1 ? '' : 's') + ': ' + res.written.join(', '));
    }

    for (const finding of reconcilePluginBindings(registry, availableCalls())) {
        log.warn('binding drift — ' + finding.reason);
    }

    // A pack switched or uninstalled AFTER a plugin installed against its exposes is exactly the state
    // nothing else would report. statData is right here, so the live half (a resolved path absent from
    // the save) runs too. Advisory, never a gate.
    // An unmatched optionalUses is the plugin's own declared choice (a standalone plugin on a card with no
    // game runs that way every load), so it is a lifecycle line; a lost requires or a vanished path warns.
    for (const finding of reconcilePluginExposes(registry, readActiveExposesFrom(entries), statData)) {
        if (finding.degradedOnly) log.lifecycle('exposes — ' + finding.reason);
        else log.warn('exposes drift — ' + finding.reason);
    }

    return { changed, reports: [] };
}

// ── the before-generation drawer ensure ──────────────────────────────────────
//
// The chat-load pass writes drawers into the LATEST message only, but a regenerate re-seeds that message's
// variables from the one BEFORE it, and a delete-then-send seeds the new reply from a floor that may never
// have carried them. So the same create-only merge runs at GENERATION_STARTED (non-dry), into the last TWO
// variable-carrying messages — every floor a new generation can seed from (tailMessagesCarryingVariables
// has the case table). Narrow next to the sync pass: no drift warns (those belong to chat load), no
// registry write. A no-op turn costs one lorebook read and up to two Mvu reads; nothing is written unless
// a drawer is absent. A chat that grew or switched between read and write aborts the write rather than
// landing it in history.
export async function ensurePluginDrawersOnGenerationFloor() {
    try {
        const entries = await getStandaloneLorebookEntries();
        if (entries === null) return;
        const { registry, error } = readPluginRegistryFrom(entries);
        if (error || !registry.activePlugins.length) return;
        const drawers = {};
        for (const rec of registry.activePlugins) if (rec.stateName) drawers[rec.stateName] = {};
        if (!Object.keys(drawers).length) return;
        const Mvu = getMvu();
        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
        const chat = ctx && ctx.chat;
        if (!Mvu || typeof Mvu.getMvuData !== 'function' || typeof Mvu.replaceMvuData !== 'function' || !Array.isArray(chat)) return;
        const floorLength = chat.length;
        for (const id of tailMessagesCarryingVariables(chat, 2)) {
            const data = await Mvu.getMvuData({ type: 'message', message_id: id });
            if (!data || typeof data !== 'object' || !data.stat_data) continue;
            const res = mergeInitSubtree(data.stat_data, { [PLUGIN_STATE_ROOT]: drawers });
            if (!res.changed) continue;
            if (ctx.chat.length !== floorLength) return;   // stale-target fence — never write into history
            await saveMessageMvuData(data, id, { writer: 'plugin-activation' });
            log.lifecycle('re-created ' + res.written.length + ' state drawer'
                + (res.written.length === 1 ? '' : 's') + ' on msg ' + id + ' before generation ('
                + res.written.join(', ') + ') — the floor this reply seeds from predated the install');
        }
    } catch (e) {
        log.warn('before-generation drawer ensure failed (non-fatal — the turn continues):', e);
    }
}

// ── export — one installed plugin back off the card ─────────────────────────

// Same contract as the pack lanes; the plugin's pieces are ALL entries, so no extra API guard is needed
// beyond a readable book. Tokens come back out through the record that substituted them.
export async function exportPlugin(id) {
    const state = await readCardPluginState();
    if (state.registryError) return { ok: false, errors: [state.registryError] };
    const record = findPluginRecord(state.registry, id);
    if (!record) return { ok: false, errors: ['no plugin "' + id + '" is installed on this card — nothing to export'] };
    const done = finishArtifactExport(buildPluginExportFile({ record, entries: state.entries }));
    if (done.ok) {
        log.lifecycle('exported "' + done.pack.id + '" v' + done.pack.version
            + ' — ' + (done.pack.entries || []).length + ' entries · engine ' + (done.pack.engine || '').length + 'ch (' + done.fileName + ')');
    }
    return done;
}
