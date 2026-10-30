// gamelogic-plugin/gamelogic-plugin-core.js — PURE decisions for the GameLogic Plugin lifecycle. No host
// imports; every branch is reachable from a test (L6).
//
// A plugin is the artifact type that is PLURAL on a card: a card runs at most one GameLogic Pack but any
// number of plugins, so this registry keeps an ARRAY where the pack's keeps one record. It is separate
// from `[GameLogicPack:Registry]` so uninstalling the game leaves the plugins' bookkeeping in place.
//
// WHAT A PLUGIN BINDS TO, and why the file cannot just say it:
//   • CALLS — a plugin's entries ride the user's own Extra LLM Calls, whose NAMES this repo can never
//     predict. So the file writes `{PRE_CALL}` / `{POST_CALL}` and the installer substitutes the name
//     the user picked. Token presence IS the declaration of the need — there is no parallel manifest
//     field, so nothing can drift from the entries.
//   • OWN ROOT — every plugin owns exactly one `stat_data` subtree, `GameLogicPlugin.<stateName>`,
//     named by the user at install time (two copies of one plugin must be able to coexist). `{OWN_ROOT}`
//     carries it into prompt text.
// Every answer the install dialog collects is recorded in the registry, because an UPGRADE reuses them
// verbatim: the user re-picks nothing.

import { compareVersions } from '../../shared/version-compare.js';
import { getPath, isPrototypeKey } from '../../shared/object-path.js';
import {
    libraryEntryComment, sectionEntryComment, buildRegistryText, parseRegistryJson, planPanelEntry, artifactIdentityRecord, buildArtifactExportFile,
    artifactIdLine, artifactRowStatus, pluginFlavorLine,
} from '../../shared/card-artifact-store.js';
import { cardAccessProblem, cardUnreadableReason } from '../../sillytavern/card-access-core.js';
import { installReachTexts } from '../../shared/pack-install-warning-core.js';

export const PLUGIN_TYPE = 'plugin';

// The platform's own namespace in stat_data. Games must never close it (rule 7 refuses a schema that
// does), and nothing here writes outside it.
export const PLUGIN_STATE_ROOT = 'GameLogicPlugin';

// The tab a user is sent to when something needs fixing by hand — spelled the way the UI spells it.
const TAB_NAME = 'GameLogic Packs';

// ── registry ─────────────────────────────────────────────────────────────────

export function pluginRegistryComment() {
    return libraryEntryComment(PLUGIN_TYPE, 'Registry');
}

export function pluginRegistryMatch() {
    return pluginRegistryComment().toLowerCase();
}

// THROWS on malformed JSON, and callers must let it: a registry read as "no plugins installed" would
// make the next uninstall sweep destructive off a typo.
// An empty body is `{"activePlugins": []}` — for plugins "none" is an empty LIST, never null.
export function parsePluginRegistry(raw) {
    const obj = parseRegistryJson(raw, { whenEmpty: '{"activePlugins":[]}' });
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('the plugin registry must be a JSON object with an "activePlugins" array');
    }
    const list = obj.activePlugins;
    if (list !== undefined && !Array.isArray(list)) {
        throw new Error('"activePlugins" must be an ARRAY (one record per installed plugin)');
    }
    return { activePlugins: (list || []).map(normalizePluginRecord) };
}

// Every field read with its "nothing recorded" value, so a hand-edited or partial record reads as a
// plugin that declares nothing and owns nothing — never as an error.
function normalizePluginRecord(rec) {
    const r = (rec && typeof rec === 'object') ? rec : {};
    const bound = (r.boundCalls && typeof r.boundCalls === 'object') ? r.boundCalls : {};
    return {
        id: String(r.id || ''),
        ver: String(r.ver || '0'),
        stateName: String(r.stateName || ''),
        boundCalls: { pre: String(bound.pre || ''), post: String(bound.post || '') },
        installedComments: Array.isArray(r.installedComments) ? r.installedComments.map(String) : [],
        requires: Array.isArray(r.requires) ? r.requires.map(String) : [],
        optionalUses: Array.isArray(r.optionalUses) ? r.optionalUses.map(String) : [],
        ...artifactIdentityRecord(r),
        schemaOwned: Boolean(r.schemaOwned),
        keepsCardSchema: Boolean(r.keepsCardSchema),
        ...(r.schema ? { schema: String(r.schema) } : {}),
        installedAt: String(r.installedAt || ''),
    };
}

export function buildPluginRegistryContent(registry) {
    return buildRegistryText(pluginRegistryComment(), TAB_NAME, registry || { activePlugins: [] });
}

export function findPluginRecord(registry, id) {
    const list = (registry && Array.isArray(registry.activePlugins)) ? registry.activePlugins : [];
    return list.find((r) => r.id === String(id || '')) || null;
}

// ── the own root ─────────────────────────────────────────────────────────────

// A state name is ONE path segment, and the restriction is the fence, not a style rule: the host
// prefixes `GameLogicPlugin.<stateName>.` onto the drawer path mechanically, so a name carrying a dot or
// a `..` would silently widen a plugin's subtree, and a prototype key (`constructor`, `prototype`) would
// lead the plugin's own-root writes off stat_data onto the page's objects.
const STATE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export function isValidStateName(value) {
    return typeof value === 'string' && STATE_NAME_RE.test(value) && !isPrototypeKey(value);
}

export function pluginOwnRoot(stateName) {
    return PLUGIN_STATE_ROOT + '.' + String(stateName || '');
}

// The install dialog's prefill: the plugin's id made into a legal segment. A SUGGESTION only — the user
// edits it, and `decideStateName` is what actually rules.
export function suggestStateName(pluginId) {
    const cleaned = String(pluginId || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+/, '');
    const head = cleaned || 'Plugin';
    return (/^[A-Za-z]/.test(head) && !isPrototypeKey(head) ? head : 'Plugin_' + head);
}

// Is this state name usable? `selfId` is the plugin being installed, so a REINSTALL or upgrade keeping
// its own name is not a collision with itself. A refusal names its `problem` — 'invalid' (not one legal
// segment) or 'taken' (another plugin's root; that plugin is `takenBy`) — for the install form to say in its
// own keyed words; `reason` is the same verdict in English, for a log.
export function decideStateName({ requested, registry, selfId = '' } = {}) {
    const name = String(requested || '');
    if (!isValidStateName(name)) {
        return { ok: false, problem: 'invalid', name, reason: '"' + name + '" is not a usable state name — one segment, starting with a letter, '
            + 'letters/digits/underscore only, and not constructor or prototype. It becomes ' + PLUGIN_STATE_ROOT + '. plus the name '
            + 'you pick, and a dot there would let the plugin write outside its own subtree.' };
    }
    const list = (registry && Array.isArray(registry.activePlugins)) ? registry.activePlugins : [];
    const clash = list.find((r) => r.stateName === name && r.id !== String(selfId || ''));
    if (clash) {
        return { ok: false, problem: 'taken', name, takenBy: clash.id, reason: '"' + name + '" is already the state root of plugin "' + clash.id
            + '" — two plugins sharing one subtree would overwrite each other. Pick another name.' };
    }
    return { ok: true, problem: '', name, reason: '' };
}

// ── the plugin's own schema (rule 7) ─────────────────────────────────────────

// The root must be declared OPEN for a plugin's drawer to accept new keys, and the platform does not
// declare it: the GAME's schema does (rule 7 guarantees a GameLogic Pack's schema leaves it open), and on
// a card with no game the PLUGIN's own schema does. That is why every plugin file ships one (rule 7) and
// the CARD decides whether it is written:
//   • a card whose GameLogic Pack owns the schema already declares the root open — writing the plugin's
//     would discard every path the game declares. Skip.
//   • a card with NO schema is judged by MVU's own derived schema, which freezes every object to the keys
//     it held at derivation — the plugin's drawer, created empty, would accept nothing. Write it.
//   • a card whose schema came from somewhere else (the card itself, another plugin) — ask, because the
//     plugin's schema only declares GameLogicPlugin open, and replacing the card's drops its own rules.
//     The answer is recorded: an upgrade or a dev-loop re-apply asks nothing again.
//   • a card still carrying the schema THIS plugin wrote earlier — replace it with the new version; it
//     is the plugin's own (pluginOwnsCardSchema).
export const SCHEMA_INSTALL_WRITE = 'write';
export const SCHEMA_INSTALL_SKIP = 'skip';
export const SCHEMA_INSTALL_ASK = 'ask';
export const SCHEMA_INSTALL_BLOCKED = 'blocked';

// The two answers to the schema question; '' = not asked yet.
export const SCHEMA_ANSWER_REPLACE = 'replace';
export const SCHEMA_ANSWER_KEEP = 'keep';

// Is the card's schema exactly the one this plugin's earlier install wrote? Ownership is the recorded
// flag AND the recorded text still being what the card carries — a schema someone replaced since is no
// longer this plugin's to update or delete.
export function pluginOwnsCardSchema(record, cardSchemaText) {
    return Boolean(record && record.schemaOwned === true && typeof record.schema === 'string'
        && record.schema !== '' && record.schema === String(cardSchemaText == null ? '' : cardSchemaText));
}

// The install's schema verdict. `record` is this plugin's registry record when it is already installed
// (null on a first install); `answer` is the schema question's answer, '' when not asked yet.
// Returns { action, reason, note } — `note` is what the success toast tells the user, '' when nothing
// about the card's schema changed.
export function decidePluginSchemaInstall({
    pluginSchemaText, cardSchemaText, packOwnsSchema = false, scriptApiUp = false, answer = '', record = null,
} = {}) {
    const mine = String(pluginSchemaText || '');
    // Rule 7 refuses a plugin file without a schema, and install validates before it decides, so an
    // empty one here is a caller that skipped validation — never written, never skipped silently.
    if (!mine.trim()) throw new Error('decidePluginSchemaInstall: the plugin carries no schema — validate the file (rule 7) before deciding');
    // A detached script API returns an empty list, which would read as "no schema on this card" and let
    // a write land on top of one.
    if (!scriptApiUp) {
        return { action: SCHEMA_INSTALL_BLOCKED, note: '',
            reason: 'the TavernHelper script API is not attached yet, so whether this card already has a schema cannot be read — retry in a moment rather than overwrite blind' };
    }
    const theirs = String(cardSchemaText == null ? '' : cardSchemaText);
    if (!theirs.trim()) {
        return { action: SCHEMA_INSTALL_WRITE, note: 'added its schema (the card had none)',
            reason: "this card has no Zod schema, so MVU's own derived schema would freeze this plugin's drawer to the keys it holds at derivation — none" };
    }
    if (packOwnsSchema) {
        return { action: SCHEMA_INSTALL_SKIP, note: '',
            reason: "the active GameLogic Pack owns this card's schema, and rule 7 guarantees it declares " + PLUGIN_STATE_ROOT + ' open — replacing it would discard every path the game declares' };
    }
    if (theirs === mine) {
        return { action: SCHEMA_INSTALL_SKIP, note: '', reason: 'this card already carries exactly this schema' };
    }
    if (pluginOwnsCardSchema(record, theirs)) {
        return { action: SCHEMA_INSTALL_WRITE, note: 'updated its own schema', reason: 'the card carries the schema this plugin installed earlier — replaced with this version' };
    }
    if (answer === SCHEMA_ANSWER_REPLACE) {
        return { action: SCHEMA_INSTALL_WRITE, note: "replaced the card's schema", reason: "replacing the card's own schema, as answered" };
    }
    if (answer === SCHEMA_ANSWER_KEEP || (record && record.keepsCardSchema === true)) {
        return { action: SCHEMA_INSTALL_SKIP, note: "kept the card's schema", reason: "keeping the card's own schema, as answered" };
    }
    return { action: SCHEMA_INSTALL_ASK, note: '',
        reason: 'this card already has a Zod schema that no GameLogic Pack installed — replacing it with this plugin\'s would declare ' + PLUGIN_STATE_ROOT + ' open and nothing else' };
}

// The schema question's one line about the surface being replaced — the `adoptable` item an install
// refusal carries, read by the Packs tab and the dev loop alike (shared adoptQuestion). A dialog line
// (sillytavern/popup-core.js): its fixed words keyed, both sizes as the value. What replacing it costs —
// the plugin's schema opens only its own root — is the question's Replace answer.
export function pluginSchemaAdoptSurface(cardSchemaText, pluginSchemaText) {
    return { text: 'The "Scheme" script, card → plugin:', name: String(cardSchemaText || '').length + ' B → ' + String(pluginSchemaText || '').length + ' B' };
}

// ── tokens ───────────────────────────────────────────────────────────────────

// A call is addressed in an entry comment as `[<name>]` — the same bracketed token the Extra LLM Calls
// router matches ANYWHERE in a comment. Substituting the brackets HERE (not just the bare name) is what
// makes a plugin entry routable at all.
export function callTag(callName) {
    return '[' + String(callName || '') + ']';
}

// Replace every declared token in one text. Absent bindings are left ALONE rather than replaced with an
// empty string: an unsubstituted `{PRE_CALL}` is visible in the entry and in rule 9's warning, whereas a
// silent blank would produce an entry routed to nothing that reads as installed correctly.
export function substituteTokens(text, { preCall = '', postCall = '', ownRoot = '' } = {}) {
    let out = String(text === undefined || text === null ? '' : text);
    if (preCall) out = out.split('{PRE_CALL}').join(callTag(preCall));
    if (postCall) out = out.split('{POST_CALL}').join(callTag(postCall));
    if (ownRoot) out = out.split('{OWN_ROOT}').join(ownRoot);
    return out;
}

// ── install decision ─────────────────────────────────────────────────────────

// `availableCalls` = [{ name, phase }] from the user's profile — the ONLY source of call names, which
// is why nothing here has a default: this module cannot invent a call the user has not configured (L1).
export function callsForPhase(availableCalls, phase) {
    const want = phase === 'post' ? 'post' : 'pre';
    return (Array.isArray(availableCalls) ? availableCalls : [])
        .filter((c) => c && String(c.name || '') && (c.phase === 'post' ? 'post' : 'pre') === want)
        .map((c) => String(c.name));
}

// What the install dialog must ASK, derived from the file itself. `needs` says which phases the plugin
// declared by using their tokens; `choices` is what the user can pick per phase; `preselect` is the
// zero-ceremony case — exactly one configured call for a needed phase, and it is chosen.
// `blocked` names a phase the plugin needs and the profile cannot satisfy: install must REFUSE, named,
// rather than write an entry routed to a call that does not exist.
export function planCallBindings({ needs, availableCalls } = {}) {
    const out = { choices: { pre: [], post: [] }, preselect: { pre: '', post: '' }, blocked: [] };
    for (const phase of ['pre', 'post']) {
        if (!(needs && needs[phase])) continue;
        const names = callsForPhase(availableCalls, phase);
        out.choices[phase] = names;
        if (names.length === 1) out.preselect[phase] = names[0];
        if (names.length === 0) {
            out.blocked.push('this plugin needs a ' + phase.toUpperCase() + ' call (its entries carry {'
                + phase.toUpperCase() + '_CALL}), and no ' + phase.toUpperCase()
                + ' call is configured in Extra LLM Calls — add one there first, then install.');
        }
    }
    return out;
}

// The action for an install attempt:
//   'no-chat'         — every write here edits the open card's book, so a chat must be open
//   'card-unreadable' — a chat IS open, but its worldbook has not answered yet. Kept apart from 'no-chat'
//                       because "open a chat first" is the wrong instruction for a user who has one open
//   'install'         — not on this card yet
//   'upgrade' / 'downgrade' / 'repair' — same id already recorded, by version comparison
// Refusals carry reasons; 'downgrade' is allowed but must be acknowledged by the caller, and carries
// `installedVersion` and `libraryVersion` for the question that asks.
export function decidePluginInstall({ isCardOpen, isChatStarted, areEntriesReadable, bookBinding, bookName, plugin, registry } = {}) {
    // The lobby/loading/unstarted ordering and the unreadable sentence are shared with every lane.
    const access = cardAccessProblem({ isCardOpen, isChatStarted, areEntriesReadable });
    if (access === 'no-chat') {
        return { action: 'no-chat', reasons: ['open a chat first — installing writes into that card\'s worldbook'] };
    }
    if (access === 'card-unreadable') {
        return { action: 'card-unreadable', reasons: [cardUnreadableReason({ binding: bookBinding, bookName })] };
    }
    if (!plugin || !plugin.id) {
        return { action: 'invalid', reasons: ['the plugin file has no id'] };
    }
    const existing = findPluginRecord(registry, plugin.id);
    if (!existing) return { action: 'install', reasons: [] };
    const libraryVersion = String(plugin.version || '0');
    const c = compareVersions(libraryVersion, existing.ver);
    if (c > 0) return { action: 'upgrade', reasons: [] };
    if (c < 0) {
        return {
            action: 'downgrade', installedVersion: existing.ver, libraryVersion,
            reasons: ['library v' + libraryVersion + ' is older than the installed v' + existing.ver],
        };
    }
    return { action: 'repair', reasons: [] };
}

// ── the write plan ───────────────────────────────────────────────────────────

// The exact card-book entries an install writes. Comment = the ownership prefix + the entry's own
// comment WITH tokens substituted, so a plugin entry is both routable (`[PRE]` reaches the call) and
// sweepable (`[GameLogicPlugin:<id>] ` reaches uninstall). Every other field passes through verbatim:
// dropping an unknown field installs an entry that renders in the wrong place, which no validator can
// catch because the file is not malformed, just wrong. `uid` is stripped — it is the source book's
// identity.
export function planPluginEntries(plugin, bindings) {
    const prefix = libraryEntryComment(PLUGIN_TYPE, plugin && plugin.id) + ' ';
    const entries = [];
    const installedComments = [];
    for (const entry of (Array.isArray(plugin && plugin.entries) ? plugin.entries : [])) {
        const { uid: _uid, ...fields } = entry;
        const comment = prefix + substituteTokens(entry.comment, bindings);
        entries.push({ ...fields, comment, content: substituteTokens(entry.content, bindings) });
        installedComments.push(comment);
    }
    return { entries, installedComments };
}

// What the install warning reads of a plugin (installReachTexts): its entries, as the file has them. A plugin ships no
// regex rows; its tokens are filled at install with names the user picked, which reach nothing; its engine and panel
// entries are silent and hold data for mvu-helper.
export function pluginReachTexts(plugin) {
    return installReachTexts({ entries: plugin && plugin.entries });
}

// Where a plugin's `engine` text lives on the CARD: a silent SECTION entry under the plugin's own
// prefix, `[GameLogicPlugin:<id>:Engine]` (sectionEntryComment in shared/card-artifact-store.js says why
// the section name sits inside the bracket). Inside the plugin's prefix, so the uninstall sweep and the
// upgrade's recorded-comment delete carry it like any other entry, and rule 4 keeps `[MVU_` for the game
// engine alone. The test `sweepNeedleMatchesEngineComment` guards that the builder and the sweep agree.
export function pluginEngineComment(id) {
    return sectionEntryComment(PLUGIN_TYPE, id, 'Engine');       // '[GameLogicPlugin:<id>:Engine]'
}

// This lane's spelling of the shared panel-entry contract (shared/card-artifact-store.js), which a
// GameLogic Pack declares the same way. The entry's comment is '[GameLogicPlugin:<id>:Panel]'.
export function planPluginPanelEntry(plugin) {
    return plugin ? planPanelEntry(PLUGIN_TYPE, plugin.id, plugin.panel) : null;
}

// The entry an install writes when the file ships an `engine` section — null when it ships none (a
// prompt-only plugin hosts nothing, which is not a fault). `enabled:false` is LOAD-BEARING: an enabled
// entry would inject the whole engine text into every prompt. The loader reads it by comment.
export function planPluginEngineEntry(plugin) {
    const text = (plugin && typeof plugin.engine === 'string') ? plugin.engine : '';
    if (!text.trim()) return null;
    return {
        comment: pluginEngineComment(plugin && plugin.id),
        content: text,
        enabled: false, type: 'constant', key: [], keys: [],
    };
}

// EVERYTHING an install will write, decided before the first write. An install whose schema question is
// still open (or whose script API is not attached) gets NO plan, so nothing lands on the card until the
// answer is in — the install writes the whole set or nothing.
// Returns { ready:false, action, reasons, adoptable? } or
//         { ready:true, entries, engineEntry, panelEntry, writesSchema, installedComments }.
export function planPluginInstall({ plugin, bindings, schemaVerdict, cardSchemaText = '' } = {}) {
    const verdict = schemaVerdict || {};
    if (verdict.action === SCHEMA_INSTALL_ASK) {
        return { ready: false, action: 'needs-adopt', reasons: [verdict.reason],
            adoptable: [pluginSchemaAdoptSurface(cardSchemaText, plugin && plugin.schema)] };
    }
    if (verdict.action === SCHEMA_INSTALL_BLOCKED) {
        return { ready: false, action: 'schema-unreadable', reasons: [verdict.reason] };
    }
    const { entries, installedComments } = planPluginEntries(plugin, bindings);
    const engineEntry = planPluginEngineEntry(plugin);
    const panelEntry = planPluginPanelEntry(plugin);
    return {
        ready: true, entries, engineEntry, panelEntry,
        writesSchema: verdict.action === SCHEMA_INSTALL_WRITE,
        installedComments: [...installedComments, ...(engineEntry ? [engineEntry.comment] : []), ...(panelEntry ? [panelEntry.comment] : [])],
    };
}

// What the success toast tells the user, beyond the verb: the interfaces the plugin matched, the ones it
// runs without, what happened to the card's schema, and where its panel slot is. Short items only.
export function pluginInstallNotes({ exposesResolved = {}, exposesDegraded = [], schemaNote = '', hostsPanel = false } = {}) {
    const notes = [];
    const matched = Object.entries(exposesResolved || {}).map(([name, path]) => name + ' → ' + path);
    if (matched.length) notes.push('uses ' + matched.join(', '));
    for (const name of (Array.isArray(exposesDegraded) ? exposesDegraded : [])) notes.push(name + ' not exposed — runs without it');
    if (schemaNote) notes.push(schemaNote);
    if (hostsPanel === true) notes.push('its panel is in the side panel (the chevron at the chat\'s right edge)');
    return notes;
}

// The registry record an install writes. Every answer is recorded because an UPGRADE reuses it verbatim.
export function buildPluginRecord({ plugin, stateName, preCall = '', postCall = '', installedComments, installedAt, schemaOwned = false, keepsCardSchema = false } = {}) {
    const schemaText = String((plugin && plugin.schema) || '');
    return {
        id: String((plugin && plugin.id) || ''),
        ver: String((plugin && plugin.version) || '0'),
        stateName: String(stateName || ''),
        boundCalls: { pre: String(preCall || ''), post: String(postCall || '') },
        installedComments: (installedComments || []).map(String),
        // The interface declarations, RECORDED: the drift check must still know what this plugin needs
        // after its file leaves the library. Verbatim from the validated file.
        requires: (plugin && Array.isArray(plugin.requires)) ? plugin.requires.map(String) : [],
        optionalUses: (plugin && Array.isArray(plugin.optionalUses)) ? plugin.optionalUses.map(String) : [],
        ...artifactIdentityRecord(plugin),
        // Did THIS plugin write the card's "Scheme" script? Uninstall deletes it only when so, and only
        // while the card still carries exactly that text (pluginOwnsCardSchema).
        schemaOwned: Boolean(schemaOwned),
        // Did the user answer the schema question "keep the card's"? An upgrade then asks nothing again.
        keepsCardSchema: Boolean(keepsCardSchema),
        // The schema TEXT, recorded whether or not it was written: the card is not a copy it can be read
        // back from, and the export owes a file that passes rule 7.
        ...(schemaText ? { schema: schemaText } : {}),
        installedAt: String(installedAt || ''),
    };
}

// Registry with one record replaced or appended — install, upgrade and repair all land here, so the
// list can never grow a duplicate id.
export function upsertPluginRecord(registry, record) {
    const list = (registry && Array.isArray(registry.activePlugins)) ? registry.activePlugins : [];
    const rest = list.filter((r) => r.id !== record.id);
    return { activePlugins: [...rest, record] };
}

export function removePluginRecord(registry, id) {
    const list = (registry && Array.isArray(registry.activePlugins)) ? registry.activePlugins : [];
    return { activePlugins: list.filter((r) => r.id !== String(id || '')) };
}

// ── binding drift ────────────────────────────────────────────────────────────

// A plugin's entries are routed by the call NAME baked into their comments, and that name lives in the
// user's profile where this extension does not control it. Rename the call and the entries stop
// routing — silently, because a comment that matches nothing is not an error anywhere.
//
// Reports one finding per broken binding: which plugin, which phase, the name it expects, and whether a
// rebind is possible (a phase with no configured calls at all cannot be rebound, only fixed in Extra
// LLM Calls).
export function reconcilePluginBindings(registry, availableCalls) {
    const list = (registry && Array.isArray(registry.activePlugins)) ? registry.activePlugins : [];
    const findings = [];
    for (const rec of list) {
        for (const phase of ['pre', 'post']) {
            const bound = rec.boundCalls && rec.boundCalls[phase];
            if (!bound) continue;
            const names = callsForPhase(availableCalls, phase);
            if (names.includes(bound)) continue;
            findings.push({
                id: rec.id,
                phase,
                expected: bound,
                candidates: names,
                reason: 'plugin "' + rec.id + '" is bound to the ' + phase.toUpperCase() + ' call "' + bound
                    + '", which is no longer configured in Extra LLM Calls — its entries route to nothing until it is rebound'
                    + (names.length ? ' (available: ' + names.join(', ') + ')' : ' (no ' + phase.toUpperCase() + ' call is configured at all)'),
            });
        }
    }
    return findings;
}

// ── exposes matching — the blind string broker ───────────────────────────────

// One plugin's declarations against the ACTIVE game's interface map. PURE and vocabulary-blind (L1):
// this function knows no interface name, it compares strings the two sides declared. Returns
//   resolved — interface name → the game's own dotted path, for every declaration that matched; this
//              exact map is what reaches the resolver ctx and the panel as `exposes`
//   blocked  — unmatched `requires`, each named: the install refusal (a plugin that REQUIRES an
//              interface the active game does not publish would run with its whole reason missing)
//   degraded — unmatched `optionalUses`, each named: the plugin runs anyway, without them
export function planExposesMatch({ requires = [], optionalUses = [], exposes = {} } = {}) {
    const map = (exposes && typeof exposes === 'object' && !Array.isArray(exposes)) ? exposes : {};
    const resolved = {};
    const blocked = [];
    const degraded = [];
    for (const name of requires) {
        if (typeof map[name] === 'string' && map[name]) { resolved[name] = map[name]; continue; }
        blocked.push('requires "' + name + '", which the active GameLogic Pack does not expose'
            + (Object.keys(map).length ? ' (it exposes: ' + Object.keys(map).join(', ') + ')' : ' (no pack is active, or it exposes nothing)'));
    }
    for (const name of optionalUses) {
        if (typeof map[name] === 'string' && map[name]) { resolved[name] = map[name]; continue; }
        degraded.push(name);
    }
    return { resolved, blocked, degraded };
}

// The chat-load half: every installed plugin's RECORDED declarations re-matched against the CURRENT
// exposes — a pack switch or uninstall after install is exactly what this catches — plus, when a live
// statData is supplied, a resolved path that no longer EXISTS in the save (advisory, never a crash).
// Returns findings in the same {id, reason} shape as reconcilePluginBindings, so the LED path and the
// warn loop treat both drifts identically.
export function reconcilePluginExposes(registry, exposes, statData) {
    const list = (registry && Array.isArray(registry.activePlugins)) ? registry.activePlugins : [];
    const findings = [];
    for (const rec of list) {
        const { resolved, blocked, degraded } = planExposesMatch({ requires: rec.requires, optionalUses: rec.optionalUses, exposes });
        for (const b of blocked) findings.push({ id: rec.id, reason: 'plugin "' + rec.id + '" ' + b });
        for (const d of degraded) findings.push({ id: rec.id, reason: 'plugin "' + rec.id + '" optionally uses "' + d + '", which is not exposed — it runs without it', degradedOnly: true });
        if (statData && typeof statData === 'object') {
            for (const [name, path] of Object.entries(resolved)) {
                if (getPath(statData, path) === undefined) {
                    findings.push({ id: rec.id, reason: 'plugin "' + rec.id + '" resolved "' + name + '" to "' + path + '", which is ABSENT from live stat_data — the interface is declared but the save holds nothing there' });
                }
            }
        }
    }
    return findings;
}

// What an installed plugin's card row shows: its id line with its state root and flavor, the calls it is bound to, then
// the shared row state (artifactRowStatus) with every drift finding — a bound call gone, a declared interface that no
// longer resolves, a card that lost its schema. Drift must SHOW, not just log: by the shared state alone, a plugin bound
// to a deleted call is complete while none of its entries reach a prompt; the shared rule adds the Drift pill. An
// optionalUses finding is the plugin's own declared choice, not drift. `rebindPhases` are the phases whose bound call is
// gone: rebinding fixes them.
export function pluginRowView({ record, libraryCopy = null, led, missing = [], bindingDrift = [], exposesDrift = [], hasCardLostSchema = false } = {}) {
    const idLine = artifactIdLine({ id: record.id, version: record.ver });
    idLine.parts.push({ name: ' · ' }, { code: pluginOwnRoot(record.stateName) }, { name: ' · ' }, ...pluginFlavorLine(record).parts);
    const bound = ['pre', 'post'].filter((phase) => record.boundCalls && record.boundCalls[phase])
        .map((phase) => phase.toUpperCase() + ' → ' + record.boundCalls[phase]);
    const drift = [...bindingDrift, ...exposesDrift.filter((finding) => !finding.degradedOnly)].map((finding) => ({ name: finding.reason }));
    if (hasCardLostSchema) drift.push({ text: "This card has no schema now, so the plugin's drawer accepts nothing. Repair writes the plugin's own." });
    const status = artifactRowStatus({ led, missing, hasLibraryCopy: Boolean(libraryCopy), drift });
    return {
        name: (libraryCopy && libraryCopy.name) || record.id,
        pills: status.pills,
        sub: [idLine, { text: 'Bound calls', name: bound.join(' · ') }, ...status.sub],
        rebindPhases: bindingDrift.map((finding) => finding.phase).filter(Boolean),
    };
}

// Rebinding rewrites the comments MECHANICALLY: the old call tag is replaced by the new one in every
// recorded comment, so the rename is followed rather than re-derived from the file (which may no longer
// be in the library). Returns the rename pairs a caller applies, plus the updated record.
export function planBindingRebind(record, phase, newCall) {
    const oldTag = callTag(record.boundCalls[phase]);
    const newTag = callTag(newCall);
    const renames = record.installedComments
        .filter((c) => c.includes(oldTag))
        .map((from) => ({ from, to: from.split(oldTag).join(newTag) }));
    const updated = {
        ...record,
        boundCalls: { ...record.boundCalls, [phase]: String(newCall || '') },
        installedComments: record.installedComments.map((c) => c.split(oldTag).join(newTag)),
    };
    return { renames, updated };
}

// ── export — the plugin file back from the card ──────────────────────────────

// Install substitutes {PRE_CALL}/{POST_CALL}/{OWN_ROOT} into comments AND content on the way in
// (planPluginEntries); export reverses it with the SAME record the substitution used, so the file ships
// re-usable tokens instead of one card's call names. split/join both ways — the reverse is exactly as
// literal as the forward pass it undoes.
export function unsubstituteTokens(text, { preCall = '', postCall = '', ownRoot = '' } = {}) {
    let out = String(text === undefined || text === null ? '' : text);
    if (ownRoot) out = out.split(ownRoot).join('{OWN_ROOT}');
    if (preCall) out = out.split(callTag(preCall)).join('{PRE_CALL}');
    if (postCall) out = out.split(callTag(postCall)).join('{POST_CALL}');
    return out;
}

// The shared artifact export (card-artifact-store buildArtifactExportFile) plus what only a plugin has:
// the Engine section entry, its call names and own root put back as tokens, and the fields its record
// carries. The schema comes from the RECORD, not the card's "Scheme" script, which may belong to a
// GameLogic Pack or to another plugin entirely — and rule 7 requires one of every plugin, so an export
// without it would produce a file the library refuses.
export function buildPluginExportFile({ record, entries } = {}) {
    const rec = record || {};
    if (!rec.id) return { pack: null, errors: ['no plugin record — nothing to export'] };
    const bound = (rec.boundCalls && typeof rec.boundCalls === 'object') ? rec.boundCalls : {};
    const bindings = { preCall: String(bound.pre || ''), postCall: String(bound.post || ''), ownRoot: pluginOwnRoot(rec.stateName) };
    return buildArtifactExportFile({
        artifactType: PLUGIN_TYPE, id: rec.id, record: rec, entries,
        identityFix: 're-install the plugin once so they are recorded',
        sections: [{ comment: pluginEngineComment(rec.id), field: 'engine', json: false }],
        mapEntry: (fields) => {
            fields.comment = unsubstituteTokens(fields.comment, bindings);
            if (typeof fields.content === 'string') fields.content = unsubstituteTokens(fields.content, bindings);
            return fields;
        },
        addTypeFields: (pack) => {
            if (rec.schema) pack.schema = String(rec.schema);
            if (Array.isArray(rec.requires) && rec.requires.length) pack.requires = rec.requires.map(String);
            if (Array.isArray(rec.optionalUses) && rec.optionalUses.length) pack.optionalUses = rec.optionalUses.map(String);
        },
    });
}
