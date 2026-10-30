// gamelogic-plugin/gamelogic-plugin-ui.js — the plugin half of the "GameLogic Packs" tab.
//
// Renders into the SAME tab as the pack, since a plugin works with the game engine: the tab's library lists both types,
// and On this card gets its own Plugins group, since a card runs one pack but any number of plugins.
//
// The install dialog is DERIVED, never authored: which phases it asks about comes from the tokens in the
// file, and what it offers comes from the user's own Extra LLM Calls. Nothing here can invent a call
// name, which is the L1 line — this repo cannot know what a user named their calls.
//
// All decisions are pure (gamelogic-plugin-core.js and shared/card-artifact-store.js); the writes are
// gamelogic-plugin-activation.js. This file is GUI only.

import { toast } from '../../sillytavern/mvu-bridge.js';
import { confirmPopup, noticePopup, formPopup } from '../../sillytavern/popup.js';
import { repairCardBookLink } from '../../sillytavern/card-access.js';
import { cardBookRepairMessage } from '../../sillytavern/card-access-core.js';
import { applyHelperLocale } from '../../sillytavern/i18n.js';
import { createModuleLog } from '../../sillytavern/log.js';
import {
    deriveArtifactLed, installedSweepNeedle, commentsMatchingNeedle,
    installActionDone, cardRowInstallButtons,
    adoptQuestion, downgradeQuestion, DOWNGRADE_QUESTION_BUTTONS, cardGroupStop,
} from '../../shared/card-artifact-store.js';
import {
    stack, field, fieldLabel, controlRow, hint, codeChip, input, select, selectOption, listRow, statusPill, button, iconButton, notice,
} from '../settings-panel/index.js';
import { listLibraryPacks, readActiveExposesFrom, schemaRemovalToastText, confirmLibraryPackReach } from '../gamelogic-pack/index.js';
import {
    readCardPluginState, availableCalls, preparePluginInstall, installPlugin, uninstallPlugin, rebindPluginCall,
    readLatestStatData, exportPlugin, readCardSchemaPresence,
} from './gamelogic-plugin-activation.js';
import { saveGeneratedFile } from '../../shared/save-file.js';
import {
    PLUGIN_TYPE, pluginOwnRoot, decideStateName, callsForPhase, reconcilePluginBindings, pluginRowView,
    reconcilePluginExposes, pluginReachTexts, SCHEMA_ANSWER_REPLACE, SCHEMA_ANSWER_KEEP,
} from './gamelogic-plugin-core.js';

const log = createModuleLog('gamelogic-plugin');

// The install dialog's OK button, per install action — fixed words, so each is a { text } the locale pass keys.
const INSTALL_BUTTON = { install: { text: 'Install' }, upgrade: { text: 'Upgrade' }, repair: { text: 'Repair' }, downgrade: { text: 'Downgrade' } };

// Repainting the plugin block alone is NOT enough after an install or uninstall: the LIBRARY list below
// it marks what is already on the card and hides the install button for it. The composition root supplies
// the whole-tab repaint here rather than this file importing it, because that barrel already imports this
// feature's (see the lane note in src/index.js).
let repaintTab = async () => {};

export function setPluginTabRepaint(fn) {
    if (typeof fn === 'function') repaintTab = fn;
}

// ── the install dialog ───────────────────────────────────────────────────────

// The call a plugin's phase is routed to: a field of the install form and of Rebind.
function pluginCallField({ phase, id, names, chosen, isInstall }) {
    return field([
        fieldLabel(phase === 'post' ? { text: 'POST call', forId: id } : { text: 'PRE call', forId: id }),
        select({ id, options: names.map((name) => selectOption({ value: name, name, isSelected: name === chosen })) }),
        isInstall
            ? hint({ text: "Its entries for this phase go to this call; their token becomes the call's tag:", chip: codeChip({ name: '{' + phase.toUpperCase() + '_CALL} → [name]' }) })
            : hint({ text: "Its entries for this phase are renamed to this call's tag." }),
    ]);
}

// Ask for the own-root name and one call per DECLARED phase. Returns the answers, or null on cancel.
// Re-asks on a bad state name, the form prefilled with what was typed.
async function askInstallAnswers(prep, registry) {
    let stateName = prep.stateName;
    let picks = { pre: prep.preselect.pre, post: prep.preselect.post };
    for (;;) {
        const plugin = prep.plugin;
        const form = document.createElement('div');
        form.innerHTML = stack([
            listRow({ icon: 'fa-puzzle-piece', name: plugin.name || plugin.id, sub: { name: 'v' + (plugin.version || '?') + (plugin.description ? ' · ' + plugin.description : '') } }),
            field([
                fieldLabel({ text: 'State root', forId: 'mvuh_plug_state' }),
                controlRow([codeChip({ name: pluginOwnRoot('') }), input({ id: 'mvuh_plug_state', value: stateName, isDisabled: prep.stateNameLocked })]),
                prep.stateNameLocked
                    ? hint({ text: 'Already installed: its state root stays, because the subtree under it is a live game.' })
                    : hint({ text: 'Everything this plugin saves lives under this one key.' }),
            ]),
            ...['pre', 'post'].filter((phase) => prep.needs[phase]).map((phase) => pluginCallField({
                phase, id: 'mvuh_plug_' + phase, names: prep.choices[phase], chosen: picks[phase], isInstall: true,
            })),
        ]);

        if (!await formPopup(form, { okButton: (INSTALL_BUTTON[prep.action] || INSTALL_BUTTON.install).text })) return null;

        stateName = prep.stateNameLocked ? prep.stateName : String(form.querySelector('#mvuh_plug_state').value || '').trim();
        const pick = (phase) => (prep.needs[phase] ? String(form.querySelector('#mvuh_plug_' + phase).value || '') : '');
        picks = { pre: pick('pre'), post: pick('post') };
        const verdict = decideStateName({ requested: stateName, registry, selfId: plugin.id });
        if (verdict.ok) return { stateName, preCall: picks.pre, postCall: picks.post };
        await noticePopup(verdict.problem === 'taken'
            ? [{ text: 'This state root already belongs to another plugin:', name: verdict.takenBy }, { text: 'Two plugins in one subtree would overwrite each other. Pick another name.' }]
            : [
                verdict.name ? { text: 'Not a usable state name:', name: verdict.name } : { text: 'The state name is blank.' },
                { text: 'Use one segment: a letter first, then letters, digits or underscores, and not constructor or prototype. A dot would let the plugin write outside its own subtree.' },
            ]);
    }
}

export async function onInstallPluginFromLibrary(id) {
    // The install warning first, before any other question or write (gamelogic-pack's library-pack-reach.js).
    if (!await confirmLibraryPackReach(PLUGIN_TYPE, id, pluginReachTexts)) return;
    let prep = await preparePluginInstall(id);
    // The one refusal mvu-helper can fix from here: a card whose lore is embedded has no worldbook to
    // write to, and SillyTavern's own Import Card Lore makes one. One yes, then prepare again — the pack
    // and menu lanes offer the same gesture at the same point.
    if (!prep.ok) {
        const repair = await repairCardBookLink();
        if (repair.resolved) {
            toast('success', cardBookRepairMessage(repair) + ' Continuing.');
            prep = await preparePluginInstall(id);
        } else if (repair.offered) {
            if (repair.reason !== 'declined') toast('error', repair.reason);
            return;
        }
    }
    if (!prep.ok) { toast('error', prep.reasons.join(' — ')); return; }
    const name = prep.plugin.name || id;
    if (prep.action === 'downgrade' && !await confirmPopup(
        downgradeQuestion({ artifactName: name, installedVersion: prep.installedVersion, libraryVersion: prep.libraryVersion }),
        DOWNGRADE_QUESTION_BUTTONS)) return;

    const state = await readCardPluginState();
    const answers = await askInstallAnswers(prep, state.registry);
    if (!answers) return;

    let res = await installPlugin(id, { ...answers, confirmDowngrade: true });
    // The card has a schema no GameLogic Pack installed, and only the user can say whether the plugin may
    // replace it. Nothing is written until they answer, and either answer installs.
    if (!res.ok && res.action === 'needs-adopt') {
        // Either button installs: Keep the card's schema is an answer here, not a cancel.
        const replace = await confirmPopup(adoptQuestion({
            artifactName: name, version: prep.plugin.version, surfaces: res.adoptable,
            answers: [
                { text: "Replace: the plugin's schema opens only its own state root, so the card's schema rules go. Uninstalling the plugin removes it." },
                { text: "Keep the card's schema: the plugin installs without its own." },
            ],
        }), { okButton: 'Replace', cancelButton: "Keep the card's schema", isDestructive: true });
        res = await installPlugin(id, { ...answers, confirmDowngrade: true, schemaAnswer: replace ? SCHEMA_ANSWER_REPLACE : SCHEMA_ANSWER_KEEP });
    }
    if (!res.ok) { toast('error', res.reasons.join(' — ')); return; }
    toast('success', 'Plugin "' + id + '" ' + installActionDone(res.action) + ' on this card.'
        + (res.notes && res.notes.length ? ' (' + res.notes.join('; ') + ')' : ''));
    const removedText = schemaRemovalToastText(res, 'Plugin "' + id + '"');
    if (removedText) toast('warning', removedText);
    await repaintTab();
}

// ── uninstall ────────────────────────────────────────────────────────────────

// The keep-or-purge question a GameLogic Pack does NOT ask, and a plugin must: a plugin's state is one
// named subtree it owns outright, so "delete it too" is both answerable and scoped. The pack's equivalent
// would span all of stat_data, which is why that button has no such option.
async function onUninstallPlugin(id, stateName) {
    const root = pluginOwnRoot(stateName);
    if (!await confirmPopup([
        { text: 'Uninstall this plugin from the card?' },
        { name: id },
        { text: 'Its entries are removed.' },
        { text: 'Its saved state stays, so a reinstall picks up where it left off:', name: root },
    ], { okButton: 'Uninstall', isDestructive: true })) return;
    const purge = await confirmPopup([
        { text: 'Also delete its saved state?' },
        { name: root },
        { text: 'Delete state: it is gone for good.' },
        { text: 'Keep state: a reinstall picks it up again (recommended).' },
    ], { okButton: 'Delete state', cancelButton: 'Keep state', isDestructive: true });
    const res = await uninstallPlugin(id, { purgeState: purge });
    if (res.ok) {
        toast('success', 'Plugin "' + id + '" uninstalled — ' + res.removedEntries + ' entries removed, state '
            + (res.purged ? 'purged' : 'kept') + '.');
        await repaintTab();
    } else toast('error', res.reasons.join(' — '));
}

// ── binding drift ────────────────────────────────────────────────────────────

async function onRebind(id, phase) {
    const names = callsForPhase(availableCalls(), phase);
    if (!names.length) {
        toast('warning', 'No ' + phase.toUpperCase() + ' call is configured — add one in Extra LLM Calls first.');
        return;
    }
    const form = document.createElement('div');
    form.innerHTML = stack([
        listRow({ icon: 'fa-puzzle-piece', name: id }),
        pluginCallField({ phase, id: 'mvuh_plug_rebind', names, chosen: names[0], isInstall: false }),
    ]);
    if (!await formPopup(form, { okButton: 'Rebind' })) return;
    const res = await rebindPluginCall(id, phase, form.querySelector('#mvuh_plug_rebind').value);
    if (res.ok) { toast('success', 'Rebound — ' + res.renamed + ' entries renamed.'); await repaintTab(); }
    else toast('error', res.reasons.join(' — '));
}

// ── rendering ────────────────────────────────────────────────────────────────

// The Rebind button's words, per phase whose bound call is gone.
const REBIND_BUTTONS = { pre: { text: 'Rebind PRE call' }, post: { text: 'Rebind POST call' } };

// One installed plugin's row (pluginRowView): Rebind for each phase whose bound call is gone, Repair or
// Upgrade when the library can run the install again, Export, then Uninstall last.
function pluginRowHtml(view, record, offer) {
    const data = (action, extra = {}) => ({ 'plug-action': action, 'plug-id': record.id, ...extra });
    return listRow({
        icon: 'fa-puzzle-piece',
        name: view.name,
        sub: view.sub,
        pills: view.pills.map(statusPill),
        actions: [
            ...view.rebindPhases.map((phase) => button({ ...REBIND_BUTTONS[phase], icon: 'fa-link', data: data('rebind', { 'plug-phase': phase }) })),
            ...(offer.repair ? [button({ text: 'Repair', icon: 'fa-screwdriver-wrench', data: data('install') })] : []),
            ...(offer.upgrade ? [button({ text: 'Upgrade', icon: 'fa-circle-up', data: data('install') })] : []),
            iconButton({ icon: 'fa-file-export', title: 'Export', data: data('export') }),
            iconButton({ icon: 'fa-trash', title: 'Uninstall', isDanger: true, data: data('uninstall', { 'plug-state': record.stateName }) }),
        ],
    });
}

// Rows for every plugin the registry records, into the card's Plugins group (its title hides while the
// group is empty). Returns the set of installed ids so the library list can mark them, exactly as the pack
// section does.
export async function refreshGameLogicPluginUI() {
    const $box = $('#mvuh_gp_plugins');
    if (!$box.length) return new Set();
    $box.empty();
    const installedIds = new Set();
    const state = await readCardPluginState();
    const stop = cardGroupStop(state);
    if (stop) {
        if (stop.notice) { $box.html(notice(stop.notice)); void applyHelperLocale(); }
        return installedIds;
    }
    const records = state.registry.activePlugins;
    if (!records.length) return installedIds;

    const library = await listLibraryPacks() || [];
    const drift = reconcilePluginBindings(state.registry, availableCalls());
    const exposesDrift = reconcilePluginExposes(state.registry, readActiveExposesFrom(state.entries), readLatestStatData());
    // A card with no schema at all freezes every plugin's drawer; Repair writes the plugin's own. Read once
    // for the block, and only concluded when the script API could answer.
    const schema = await readCardSchemaPresence();
    const hasCardLostSchema = schema.readable && !schema.hasSchema;
    $box.html(records.map((record) => {
        installedIds.add(record.id);
        const libraryCopy = library.find((p) => p.packType === PLUGIN_TYPE && p.id === record.id) || null;
        const led = deriveArtifactLed({
            inLibrary: Boolean(libraryCopy), isActive: true,
            recordedComments: record.installedComments,
            presentComments: commentsMatchingNeedle(state.entries, installedSweepNeedle(PLUGIN_TYPE, record.id)),
        });
        const view = pluginRowView({
            record, libraryCopy, led: led.state, missing: led.missing,
            bindingDrift: drift.filter((finding) => finding.id === record.id),
            exposesDrift: exposesDrift.filter((finding) => finding.id === record.id),
            hasCardLostSchema,
        });
        const offer = cardRowInstallButtons({
            ledState: led.state, hasLibraryCopy: Boolean(libraryCopy), needsReinstall: hasCardLostSchema,
            libraryVersion: libraryCopy && libraryCopy.version, installedVersion: record.ver,
        });
        return pluginRowHtml(view, record, offer);
    }).join(''));
    void applyHelperLocale();          // rebuilt markup carries data-i18n keys that were never translated
    return installedIds;
}

// Delegated from the Plugins list this file paints (#mvuh_gp_plugins, inside On this card), wired once by the composition
// root.
export function wireGameLogicPluginHandlers() {
    // One installed plugin back off the card, as a file — refusals name themselves.
    async function onExportPlugin(id) {
        const res = await exportPlugin(id);
        if (!res.ok) {
            for (const e of res.errors) log.warn('export refused: ' + e);
            toast('error', 'Not exported — ' + res.errors[0]);
            return;
        }
        for (const w of (res.warnings || [])) log.warn('export warning: ' + w);
        saveGeneratedFile(res.fileName, res.text, 'application/json');
        toast('success', 'Exported ' + res.fileName);
    }

    $('#mvuh_gp_plugins').on('click', '[data-plug-action]', async function onClick(ev) {
        ev.preventDefault();
        const $el = $(this);
        const action = $el.data('plug-action');
        const id = String($el.data('plug-id') || '');
        try {
            if (action === 'install') await onInstallPluginFromLibrary(id);
            else if (action === 'uninstall') await onUninstallPlugin(id, String($el.data('plug-state') || ''));
            else if (action === 'rebind') await onRebind(id, String($el.data('plug-phase') || 'pre'));
            else if (action === 'export') await onExportPlugin(id);
        } catch (e) {
            log.error('' + action + ' failed:', e);
            toast('error', 'Plugin ' + action + ' failed — see console.');
        }
    });
}
