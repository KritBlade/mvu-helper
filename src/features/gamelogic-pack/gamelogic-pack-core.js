// gamelogic-pack/gamelogic-pack-core.js — PURE logic for the pack file format, the library's naming
// scheme, and the ACTIVATION decisions. No host imports, unit-testable; the lorebook I/O lives in
// gamelogic-pack-library.js and gamelogic-pack-activation.js.
//
// ONE file format, FOUR packTypes ("gamelogic" | "statusmenu" | "plugin" | "eventpack") — shared header
// first, type-specific sections after. The validator here is the install-to-library gate: every refusal
// names its rule, because a pack author debugging a rejection needs the rule, not a generic "invalid
// file". (Warn-never-refuse applies to RENDERING someone's menu; a malformed FILE at import time is
// exactly where refusing loudly is the kind option.)
//
// A section this version does not KNOW is the one thing that never refuses: it is named, it is left
// uninstalled, and every other section installs — see the unknown-section walk in validatePack. That is
// what lets a later format add a section with no migration and no forward-compatibility flag.

import { declaredVersionOf } from '../../shared/engine-header.js';
import { compareVersions, isVersionString } from '../../shared/version-compare.js';
import {
    libraryEntryComment,
    parseRegistryJson, buildRegistryText,
    planPanelEntry, artifactIdentityRecord,
    buildArtifactExportFile,
} from '../../shared/card-artifact-store.js';
import { assembleArtifactSource, splitWorkspaceSources, normalizeWorkspaceRoot } from '../../shared/artifact-source-assembler.js';
import { gateArtifactSource, menuEngineTextToRead } from '../../shared/artifact-source-gates.js';
import { isTavernHelperFrontendText, TAVERNHELPER_FRONTEND_TOKENS } from '../../shared/rendered-region.js';
import { installReachTexts } from '../../shared/pack-install-warning-core.js';
import { filterSchemaScript } from './gamelogic-pack-schema-allowlist.js';
// tavern-regex-core.js is PURE (zero imports, zero globals) despite living beside the host wrappers — it
// holds the SHAPE of a TavernHelper regex, which is host knowledge but not a host call. Importing it here
// keeps one definition of "which of these names is not ours" instead of a second copy in this file (P4 is
// about who may touch host APIs; nothing in that module does).
import { conflictingRegexNames } from '../../sillytavern/tavern-regex-core.js';
import { MVUHELPER_STAT_ROOT } from '../../sillytavern/mvu-bridge-core.js';
// Also pure (same L6 stance as the import above): the shared lobby/loading/unstarted ordering.
import { cardAccessProblem, cardUnreadableReason } from '../../sillytavern/card-access-core.js';
// Also pure: a dialog line read back as plain text, for the reason that lists the adopt question's surfaces.
import { dialogLineText } from '../../sillytavern/popup-core.js';

// ── names — FROZEN ───────────────────────────────────────────────────────────

// The library, the needle family and the lifecycle decisions live in shared/card-artifact-store.js:
// event-pack is the second consumer, which is what makes them a shared module. The entry-comment builders
// a pack-file consumer needs are re-exported here, because where they live is not information it needs.
export { libraryEntryComment, planPanelEntry };

// The four types the pack-FILE format covers — the same four the library holds (ARTIFACT_TYPES). An
// eventpack passes through this validator in its WORKSPACE form, pack.json plus an events/ folder
// (rule 2b); the event-pack text inside each events/ file has its own format and its own validator
// (event-pack-core.js), which this file never reads.
export const PACK_TYPES = ['gamelogic', 'statusmenu', 'plugin', 'eventpack'];

// The schema script's NAME (frozen): matches what School v4 already ships, so an existing card is
// recognised rather than duplicated. Written character-scoped at activation; deleted at uninstall
// ONLY when schemaOwned. The `mvu` script is bootstrap's, never a pack's.
export const SCHEMA_SCRIPT_NAME = 'Scheme';

// ── file format ──────────────────────────────────────────────────────────────

// Shared header fields every packType carries.
const SHARED_KEYS = ['format', 'packType', 'id', 'name', 'description', 'version', 'builtWith', 'entries'];

// Which type-specific sections each packType may carry. Used BOTH ways by rule 2: a section
// present on the wrong type errors naming the section AND the type it belongs to.
// A PLUGIN has no `init`: it declares no state shape. The host creates its drawer
// (`GameLogicPlugin.<stateName>`) empty, and the plugin creates its own keys as it needs them, under a
// root the card's schema declares open (rule 7). A plugin carrying `init` is refused by name, because it
// would install with that seed silently never applied.
// `regex` on BOTH gamelogic and statusmenu, because the two own different surfaces and the ownership is
// what decides, not the mechanism:
//   • gamelogic — regexes that hide or restyle the GAME's own output (<UpdateVariable>, <combat_log>,
//     <StoryAnalysis>). Those tags come from the pack's own prompt entries, so the pack that emits a tag
//     is the pack that hides it. Hiding and restyling is ALL a gamelogic row may do: one that would make
//     TavernHelper render a document is refused (rule 10), because that document runs on the page.
//   • statusmenu — the regexes that ARE the menu. Their replaceString is the rendered menu HTML, and the
//     whole chain that produces it (layout project → StatusMenu Builder → HTML → regex) is one duty.
// NOT on `plugin`: a plugin writes into its own state root and has no card surface of its own, so a regex
// there would be reaching into someone else's output with nothing to arbitrate it.
//
// Two owners on one card's regex LIST is fine — they never name the same regex, and mvu-helper's
// overwrite check (conflictingRegexNames) refuses per NAME, so a collision between two packs is caught
// the same way a collision with the user's own is. What would NOT be fine is one surface claimed by two
// packs, which is why the split that produces these files gates on a name appearing in two sources.
// `panel` on `plugin` AND `gamelogic` (devdoc/side-panel-format.md): a slot in mvu-helper's own side
// panel, declared the way a StatusMenu layout is — carried verbatim, `kind` + `format` read, nothing
// else inspected. Both types own state a reader would want on screen, so both may declare one, and the
// only difference is the scope its paths are read against: a plugin's own drawer, a pack's `stat_data`.
// NOT on `statusmenu`: that artifact IS a display artifact and its declaration is `layout`. Two display
// declarations in one file would be two answers to "what does this draw", with nothing to arbitrate.
// An EVENTPACK carries `events` and nothing else. Its files ARE lorebook entries once installed —
// the install lane derives each entry from the file's own <mvueventpack> block — so `entries` beside
// them would be a second source for the same thing, and rule 2b refuses it by name rather than
// installing both. It owns no engine, no schema and no regex for the same reason a plugin owns no
// regex: its whole surface is the entries it creates under its own key prefix, and the trigger rows
// it merges into the EventPack root. One artifact is ONE pack — the format caps a pack at
// MAX_ROWS_PER_PACK rows, so a long route splits into several artifacts that chain by prereq.
const SECTIONS_BY_TYPE = {
    gamelogic: ['engine', 'state', 'exposes', 'schema', 'regex', 'regexOrder', 'panel'],
    statusmenu: ['engine', 'layout', 'targetsPackId', 'regex', 'regexOrder'],
    plugin: ['engine', 'requires', 'optionalUses', 'panel', 'schema'],
    eventpack: ['events'],
};

// Rule 7 machinery. The platform roots are the two whose keys no game author can know: GameLogicPlugin, where
// each installed plugin names its own drawer at install time, and mvu-helper's own root, whose parts mvu-helper
// adds as it grows. The plugin root is named here rather than imported from the plugin feature: the validator
// is what every packType goes through, and a cross-feature import for one string would close a cycle (the
// plugin lane already imports this barrel).
const PLUGIN_ROOT_NAME = 'GameLogicPlugin';
const PLATFORM_ROOT_NAMES = [PLUGIN_ROOT_NAME, MVUHELPER_STAT_ROOT];
const PLATFORM_ROOT_LIST = PLATFORM_ROOT_NAMES.map((name) => '"' + name + '"').join(' and ');
// Who names the keys inside each platform root: what a closed declaration of it strips.
const PLATFORM_ROOT_KEYS_OWNER = {
    [PLUGIN_ROOT_NAME]: "a plugin names its own keys there at install time, so every plugin's state would go",
    [MVUHELPER_STAT_ROOT]: 'mvu-helper names its own parts there (what each character wears, the character registry), so they would go',
};

// ONE "open" test for every declaration rule 7 reads, each platform root's and the registered root's
// alike. A declaration keeps a key it was never told about when its base form is open (z.record, z.any,
// z.looseObject), or when a closed form is reopened by a chained call: `.passthrough()`, `.loose()`, or
// `.catchall(<schema>)`, which keeps an unknown key by VALIDATING it. `.catchall(z.never())` is the one
// exception — it refuses an unknown key instead of keeping it — so it is not an opener. Verified on zod
// 4.4.3: passthrough/loose/catchall(z.any()) all keep an undeclared key; catchall(z.never()) and strict()
// refuse it loudly; a bare `z.object` drops it silently. OPEN_FORMS is what the refusal messages tell an
// author to write instead, so it names only forms the schema allow-list keeps (`.loose()` is not one).
const OPEN_FORMS = ['z.record(...)', 'z.any()', 'z.looseObject(...)', '.passthrough()', '.catchall(z.any())'];
const OPEN_BASE_FORM_MATCH = /z\s*\.\s*record\s*\(|z\s*\.\s*any\s*\(\s*\)|looseObject/;
const REOPENER_MATCH = /\.\s*(?:passthrough|loose)\s*\(|\.\s*catchall\s*\(\s*(?!z\s*\.\s*never\b)/;

// Where a root's declared value starts — just past `<name>:`, the key bare or quoted, as a generator writes
// a key that is not an identifier — or -1 when the schema does not declare it.
function rootDeclarationAt(schemaText, rootName) {
    const name = String(rootName).replace(/[$.*+?^()[\]{}|\\]/g, '\\$&');
    const found = new RegExp('(?:^|[^\\w$])[\'"]?' + name + '[\'"]?\\s*:\\s*').exec(String(schemaText));
    return found ? found.index + found[0].length : -1;
}

// Is a root's declaration open? Its OWN form is read, as the registered root's is: a `z.<form>(…)` value is
// open when the form is, or when an opener is chained onto it past its own closing paren, so a nested
// `z.record` inside a closed `z.object({ … })` cannot vouch for it. A value that is not a `z.<form>(` call
// (a const declared elsewhere) is read by its line alone.
function declaresRootOpenly(schemaText, rootName) {
    const text = String(schemaText);
    const at = rootDeclarationAt(text, rootName);
    if (at < 0) return false;
    const call = /^z\s*\.\s*(\w+)\s*\(/.exec(text.slice(at));
    if (!call) {
        const line = text.slice(at).split('\n')[0];
        return OPEN_BASE_FORM_MATCH.test(line) || REOPENER_MATCH.test(line);
    }
    if (OPEN_DECLARATION_FORMS.includes(call[1])) return true;
    const close = endOfCall(text, at);
    if (close < 0) return false;
    return REOPENER_MATCH.test(text.slice(close, close + ROOT_CHAIN_SCAN_LIMIT).split('\n')[0]);
}
const OPEN_DECLARATION_FORMS = ['record', 'any', 'looseObject'];

const declaresEveryPlatformRootOpenly = (schemaText) => PLATFORM_ROOT_NAMES.every((name) => declaresRootOpenly(schemaText, name));

// How far past the root's own closing paren its chain is read. The chain is `.passthrough().prefault({})`
// in every shape seen; the cap stops a runaway scan on a schema whose parentheses do not balance.
const ROOT_CHAIN_SCAN_LIMIT = 400;

// Where the call whose first `(` follows `from` closes, or -1 when it does not balance in this text.
// String literals are skipped so a paren inside a message cannot end the call early, and comments are
// skipped so an apostrophe in one ("it's") cannot open a string that never closes.
function endOfCall(text, from) {
    let depth = 0;
    let quote = '';
    for (let at = text.indexOf('(', from); at >= 0 && at < text.length; at++) {
        const ch = text[at];
        if (quote) {
            if (ch === '\\') at++;
            else if (ch === quote) quote = '';
            continue;
        }
        if (ch === '/' && text[at + 1] === '/') {
            const lineEnd = text.indexOf('\n', at);
            if (lineEnd < 0) return -1;
            at = lineEnd;
            continue;
        }
        if (ch === '/' && text[at + 1] === '*') {
            const commentEnd = text.indexOf('*/', at + 2);
            if (commentEnd < 0) return -1;
            at = commentEnd + 1;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) return at + 1;
    }
    return -1;
}

// The registered ROOT's own shape: its base form — 'object', 'looseObject', 'strictObject', … — and
// whether an opener is chained onto THAT root. null when the text does not say plainly enough to accuse
// anyone. Reads the identifier registerMvuSchema is handed and then that identifier's own `= z.<form>(`;
// a form or an opener appearing anywhere else in the file cannot vouch for it, so the chain is found by
// walking the root's own parentheses to their close and reading only what follows.
// Text, not evaluation, because this validator stays zod-free by design (the builder takes zod, the
// platform does not) — so it answers only when it is sure and stays silent otherwise.
function registeredRootShape(schemaText) {
    const text = String(schemaText || '');
    let baseForm = null;
    let formAt = -1;
    // Registered INLINE: registerMvuSchema(z.<form>({ … }))
    const inline = /registerMvuSchema\s*\(\s*(z\s*\.\s*(\w+))/.exec(text);
    if (inline) {
        baseForm = inline[2];
        formAt = inline.index + inline[0].length - inline[1].length;
    } else {
        // Registered BY NAME: registerMvuSchema(Ident), with `const Ident = z.<form>(` elsewhere
        const registered = /registerMvuSchema\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(text);
        if (!registered) return null;
        const declared = new RegExp('(?:const|let|var)\\s+' + registered[1] + '\\s*=\\s*(z\\s*\\.\\s*(\\w+))').exec(text);
        if (!declared) return null;      // groups shift by one: (?:const|let|var) is non-capturing
        baseForm = declared[2];
        formAt = declared.index + declared[0].length - declared[1].length;
    }
    const close = endOfCall(text, formAt);
    if (close < 0) return null;   // the root's parentheses do not balance, so its chain cannot be read
    const chain = text.slice(close, close + ROOT_CHAIN_SCAN_LIMIT).split(';')[0];
    return { baseForm: baseForm, isOpened: REOPENER_MATCH.test(chain) };
}

// The root forms that lose a root they were not told about, and HOW each one loses it — the two fail
// differently and the refusal has to name the right one. Anything else (looseObject, record, any, or a
// form this list has never heard of) passes, because a wrong refusal here blocks a working artifact.
// This is what the form does ON ITS OWN, which is what the author wrote; see the refusal for why that
// is the right thing to measure even when mvu_zod is currently patching it.
const CLOSED_ROOT_FAILURE = {
    object: 'STRIPS every root it does not name, silently, on the next write',
    strictObject: 'REFUSES every write that carries a root it does not name, so the card stops saving',
};
const CLOSED_ROOT_FORMS = Object.keys(CLOSED_ROOT_FAILURE);

// Does the registered root strip? A closed base form with nothing reopening it.
function isRegisteredRootClosed(schemaText) {
    const shape = registeredRootShape(schemaText);
    return Boolean(shape && !shape.isOpened && CLOSED_ROOT_FORMS.includes(shape.baseForm));
}

// Rule 5 machinery — the derived-format cross-check. EVERY section is a "1.0" section, so the check
// cannot fire yet; the table exists so that the FIRST format bump has somewhere to land, and the
// validator takes it as a parameter so a test can prove the gate works before reality needs it (a gate
// no input can reach can ship broken with nothing to say so).
export const SECTION_MIN_FORMAT = {
    engine: '1.0', layout: '1.0', state: '1.0', exposes: '1.0',
    requires: '1.0', optionalUses: '1.0', targetsPackId: '1.0', schema: '1.0', entries: '1.0',
    regex: '1.0', regexOrder: '1.0', panel: '1.0', events: '1.0',
};

// "major.minor" compare, local and tiny — pack-file formats are exactly two numbers, not semver.
function fmtParts(s) {
    const m = String(s || '').match(/^(\d+)\.(\d+)$/);
    return m ? [Number(m[1]), Number(m[2])] : null;
}
function fmtLess(a, b) {   // a < b
    const pa = fmtParts(a), pb = fmtParts(b);
    if (!pa || !pb) return false;
    return pa[0] !== pb[0] ? pa[0] < pb[0] : pa[1] < pb[1];
}

// The highest format any present section demands — rule 5's "derived" half.
export function requiredFormat(pack, table = SECTION_MIN_FORMAT) {
    let req = '1.0';
    for (const key of Object.keys(table)) {
        if (pack && pack[key] !== undefined && fmtLess(req, table[key])) req = table[key];
    }
    return req;
}

// The highest format THIS mvu-helper understands — rule 5's forward half, and the number the unknown
// -section warning quotes. DERIVED from the same table rather than declared as a second constant: a
// section added to SECTION_MIN_FORMAT at a new number raises the ceiling in the same edit, so there is
// no version to bump separately and none to forget. It is what makes forward compatibility SELF-
// ANNOUNCING — a file from a newer helper is named and installed, never silently half-read.
export function supportedFormat(table = SECTION_MIN_FORMAT) {
    let max = '1.0';
    for (const key of Object.keys(table)) {
        if (fmtLess(max, table[key])) max = table[key];
    }
    return max;
}

// id: kebab-case — lowercase letters/digits in single-hyphen-separated runs. It rides lorebook
// needles, the CSS scope [data-pack="<id>"] and locale keys pack.<id>., so it must be path- and
// selector-safe; the AUTHORING tool derives it from the display name and lets the author edit.
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isKebabCaseId(id) {
    return typeof id === 'string' && KEBAB_RE.test(id);
}

// Rule 4 — comment prefixes the INSTALLER owns. Refused ANYWHERE in an author's comment, not only at
// its head: needles match anywhere (card-artifact-store.js), so a control token mid-comment would spoof
// another artifact's sweep — and the installer's own section entries (`[<Prefix>:<id>:Engine]`,
// `:Panel]`, and the menu's published `] (Layout)`) live inside this namespace, which is what reserves them without a marker list.
export const CONTROL_COMMENT_PREFIXES = ['[mvu_', '[gamelogicpack:', '[statusmenupack:', '[gamelogicplugin:'];

function containsControlPrefix(comment) {
    const c = String(comment || '').toLowerCase();
    return CONTROL_COMMENT_PREFIXES.some((p) => c.includes(p));
}

// Rule 6 — every path inside `layout` where a `customLogic` key appears. The layout is 100%
// declarative; logic belongs in the StatusMenu Engine, and the refusal names each site so the
// author knows exactly what to move rather than hunting a single anonymous "no".
export function findCustomLogicSites(layout) {
    const sites = [];
    const walk = (node, path) => {
        if (!node || typeof node !== 'object') return;
        for (const key of Object.keys(node)) {
            const at = path ? path + '.' + key : key;
            if (key === 'customLogic') { sites.push(at); continue; }
            walk(node[key], at);
        }
    };
    walk(layout, '');
    return sites;
}

// ── the plugin half of the format ────────────────────────────────────────────

// An interface name: `<name>@<major>` (`cast@1`, `clock@1`). The broker that matches these is
// BLIND: it hardcodes no interface vocabulary (L1), it compares strings. That is precisely why the
// SHAPE has to be checked HERE. A malformed name cannot match anything a game exposes, so left
// unchecked it surfaces at install time as "the active game does not expose Cast@1.0" — a message
// that blames the GAME for the plugin author's typo, and sends them to the wrong repo.
const INTERFACE_RE = /^[a-z][a-z0-9-]*@\d+$/;
export function isInterfaceName(value) {
    return typeof value === 'string' && INTERFACE_RE.test(value);
}

// The tokens the installer substitutes at install. `{OWN_ROOT}` becomes the plugin's fenced
// state root; the two call tokens become the calls the user bound.
export const PLUGIN_TOKENS = ['{PRE_CALL}', '{POST_CALL}', '{OWN_ROOT}'];
const TOKEN_SHAPE_RE = /\{[A-Z][A-Z0-9_]*\}/g;

// Every place a token may legally appear: a comment (the call tokens ride there) and
// the content. Joined so presence is ONE question asked of the whole file.
function pluginTokenText(pack) {
    const entries = Array.isArray(pack && pack.entries) ? pack.entries : [];
    return entries.map((e) => String((e && e.comment) || '') + '\n' + String((e && e.content) || '')).join('\n');
}

// TOKEN PRESENCE IS THE BINDING DECLARATION. There is deliberately no manifest field saying
// "this plugin needs a PRE call": a second spelling could disagree with the entries, and the install
// dialog would then ask for a binding nothing uses (or skip one something needs). The GUI derives its
// dialog from this, so the entries are the single source.
export function declaredCallBindings(pack) {
    const text = pluginTokenText(pack);
    return { pre: text.includes('{PRE_CALL}'), post: text.includes('{POST_CALL}') };
}

// Rule 15. A plugin entry whose comment carries a call token is routed to that call, which reads it whether
// or not the entry is enabled (routing reads the comment). SillyTavern also injects an entry into the
// narrator's prompt when it is enabled and either constant or keyed, and a call's contract read by the
// narrator is a second, unasked-for instruction. Returns why SillyTavern would inject it, or '' when it never
// would: disabled, or enabled and "selective" with no keys. Only a plugin can be judged here — its call
// tags are tokens; a GameLogic Pack's tags are call names this validator does not know.
function routedEntryNarratorExposure(entry) {
    const comment = String((entry && entry.comment) || '');
    if (!comment.includes('{PRE_CALL}') && !comment.includes('{POST_CALL}')) return '';
    if (entry.enabled === false) return '';
    if (entry.type === 'constant' || entry.constant === true) return 'it is enabled and constant';
    const keys = [].concat(Array.isArray(entry.keys) ? entry.keys : [], Array.isArray(entry.key) ? entry.key : [])
        .filter((k) => String(k || '').trim());
    return keys.length ? 'it is enabled and has keys' : '';
}

// Tokens shaped like ours that we do NOT substitute — almost always a typo of one that we do
// (`{OWNROOT}`, `{PRE_CALLS}`). Returned deduped, in first-seen order.
export function unknownPluginTokens(pack) {
    const found = pluginTokenText(pack).match(TOKEN_SHAPE_RE) || [];
    return [...new Set(found.filter((t) => !PLUGIN_TOKENS.includes(t)))];
}

// JSON-parse a pack file. Split from validatePack so the UI can distinguish "not JSON at all" from
// "JSON that breaks a rule" — different fixes, different messages.
export function parsePackFile(text) {
    let pack;
    try { pack = JSON.parse(String(text || '')); }
    catch (e) { return { pack: null, error: 'not valid JSON: ' + (e && e.message || e) }; }
    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
        return { pack: null, error: 'the file must be one JSON object' };
    }
    return { pack, error: '' };
}

// ── the validator — install-to-library time, every rule named on refusal ─────
//
// Returns { ok, errors, warnings, unknownSections, declaredFormat, supportedFormat }. `errors` block
// the install; `warnings` inform (absent version, unknown sections). The last three are the same
// finding as the unknown-section warning, STRUCTURED — the UI composes its own short toast from them
// instead of parsing a sentence back apart. opts.sectionMinFormat overrides the rule-5 table — tests only.
export function validatePack(pack, opts = {}) {
    const errors = [];
    const warnings = [];
    const unknownSections = [];
    const table = opts.sectionMinFormat || SECTION_MIN_FORMAT;
    const supported = supportedFormat(table);

    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
        return { ok: false, errors: ['rule 1: the pack must be one JSON object'], warnings, unknownSections, declaredFormat: '', supportedFormat: supported };
    }

    // Rule 1 — required header fields, each checked for shape, not just presence.
    if (typeof pack.format !== 'string' || !fmtParts(pack.format)) {
        errors.push('rule 1: "format" is REQUIRED and must be "<major>.<minor>" (e.g. "1.0") — no silent default: the author or tool could always have declared it');
    }
    if (!PACK_TYPES.includes(pack.packType)) {
        // Spelled from PACK_TYPES rather than retyped: a type added to the list and not to the message
        // is a refusal that names the wrong set of choices.
        errors.push('rule 1: "packType" is REQUIRED and must be one of ' + PACK_TYPES.map((t) => '"' + t + '"').join(' | ') + ' (got ' + JSON.stringify(pack.packType) + ')');
    }
    if (typeof pack.id !== 'string' || !pack.id) {
        errors.push('rule 1: "id" is REQUIRED');
    } else if (!isKebabCaseId(pack.id)) {
        errors.push('rule 1: "id" must be kebab-case (lowercase letters/digits, single hyphens — got ' + JSON.stringify(pack.id) + '); it rides lorebook needles, [data-pack] CSS scopes and locale keys');
    } else if (pack.id === 'registry') {
        // RESERVED: the registry entry's own comment is [GameLogicPack:Registry], so a pack with this id
        // would make the uninstall sweep needle ([gamelogicpack:registry]) delete the registry itself.
        errors.push('rule 1: the id "registry" is reserved — it collides with the ' + packRegistryComment(pack.packType) + ' bookkeeping entry');
    }
    if (typeof pack.name !== 'string' || !pack.name.trim()) {
        errors.push('rule 1: "name" is REQUIRED (display name, any script)');
    }
    if (typeof pack.description !== 'string' || !pack.description.trim()) {
        errors.push('rule 1: "description" is REQUIRED (one line — the library list and install dialog show it)');
    }
    if (pack.version === undefined) {
        warnings.push('"version" is absent — install, upgrade and the Upgrade button compare versions, so an update to this pack cannot be told apart from a re-import');
    } else if (!isVersionString(pack.version)) {
        errors.push('rule 1: "version", when present, must be M.m or M.m.r — numbers only, e.g. "1.2" or "1.2.0" (got '
            + JSON.stringify(pack.version) + '). Upgrades compare it number by number, so a version like "v1.2" or "1.2-beta" would order wrong');
    }

    // Rule 1 (well-formed) — entries shape. Comments are load-bearing: the installer prefixes them and
    // the uninstall list is built from them, so an entry without one could never be removed exactly.
    if (pack.entries !== undefined) {
        if (!Array.isArray(pack.entries)) {
            errors.push('rule 1: "entries", when present, must be an array');
        } else {
            pack.entries.forEach((entry, i) => {
                if (!entry || typeof entry !== 'object' || typeof entry.comment !== 'string' || !entry.comment.trim()) {
                    errors.push('rule 1: entries[' + i + '] must be an object with a non-empty string "comment" (the installer prefixes it; uninstall finds it by it)');
                    return;
                }
                if (entry.content !== undefined && typeof entry.content !== 'string') {
                    errors.push('rule 1: entries[' + i + '] ("' + entry.comment + '") — "content" must be a string');
                }
                // Rule 4 — the installer owns control prefixes.
                if (containsControlPrefix(entry.comment)) {
                    errors.push('rule 4: entries[' + i + '] comment "' + entry.comment + '" contains a control prefix ([MVU_ / [GameLogicPack: / [StatusMenuPack: / [GameLogicPlugin:) — the installer owns that namespace; name the entry plainly');
                }
                // Rule 15 — a plugin entry routed to a call stays out of the narrator's prompt.
                const narratorExposure = pack.packType === 'plugin' ? routedEntryNarratorExposure(entry) : '';
                if (narratorExposure) {
                    errors.push('rule 15: entries[' + i + '] ("' + entry.comment + '") is routed to a call, but SillyTavern would also put it in the narrator\'s prompt (' + narratorExposure + ') — disable it, or make it "selective" with no keys');
                }
            });
        }
    }

    // Rule 2 — sections must match the declared packType, both directions derivable from one table.
    if (PACK_TYPES.includes(pack.packType)) {
        const allowed = SECTIONS_BY_TYPE[pack.packType];
        for (const [type, sections] of Object.entries(SECTIONS_BY_TYPE)) {
            if (type === pack.packType) continue;
            for (const section of sections) {
                if (pack[section] !== undefined && !allowed.includes(section)) {
                    errors.push('rule 2: a "' + pack.packType + '" file may not carry "' + section + '" — that section belongs to packType "' + type + '"');
                }
            }
        }
        // Unknown top-level keys: warn, never refuse — every OTHER section installs, which is what makes
        // a future format's section safe to add without a migration. Rule 5 (not this walk) is what
        // gates formats.
        //
        // TWO CAUSES, split by the declared format, because one message for both sends half the readers
        // hunting the wrong thing: a file from a NEWER helper needs an UPDATE, an unknown key at the same
        // format is the author nesting a renderer/engine field one level too high.
        const known = new Set([...SHARED_KEYS, ...allowed]);
        const fromNewerHelper = fmtLess(supported, pack.format);
        for (const key of Object.keys(pack)) {
            if (!known.has(key) && !Object.values(SECTIONS_BY_TYPE).flat().includes(key)) {
                unknownSections.push(key);
                warnings.push('unknown TOP-LEVEL section "' + key + '" — the file declares format '
                    + JSON.stringify(pack.format) + ' and this mvu-helper understands ' + supported + '. '
                    + 'That section is NOT installed; every other section is. '
                    + (fromNewerHelper
                        ? 'The file was built for a NEWER mvu-helper — update it to get this section.'
                        : 'Nothing newer is expected at this format, so this is most likely misplaced: top level is '
                          + 'the HOST namespace, and a field a RENDERER or an ENGINE reads belongs inside the section '
                          + 'that carries it (layout / panel / engine / entries), where this check never looks'));
            }
        }
        // A newer format carrying only sections we DO know still means a known section may have been
        // redefined at that number — read the old way here, with nothing to name. Reported only when the
        // walk above found nothing, so one file never produces two versions of the same news.
        if (fromNewerHelper && !unknownSections.length) {
            warnings.push('the file declares format ' + JSON.stringify(pack.format) + ', newer than the '
                + supported + ' this mvu-helper understands. Every section here is one this version knows, so it '
                + 'installs — but a section REDEFINED at the newer format would be read the old way. Update mvu-helper.');
        }
    }

    // Rule 2b — an eventpack IS its events/ directory. An empty one assembles to a pack with no
    // section at all, which would install cleanly and do nothing: the silent mode this project keeps
    // closing. The CONTENT of each file is not read here — its format belongs to the event-pack
    // feature and this validator runs in node for the dev server (see the assembler's events/ note) —
    // so this checks that files exist and that nothing else claims to carry the same entries.
    if (pack.packType === 'eventpack') {
        if (!Array.isArray(pack.events) || !pack.events.length) {
            errors.push('rule 2b: an "eventpack" file needs at least one file in events/ — that directory IS the pack, and one with none installs nothing');
        }
        if (pack.entries !== undefined) {
            errors.push('rule 2b: an "eventpack" file may not carry "entries" — its lorebook entries are DERIVED from the events/ files at install, so a second set here would be a second source for the same thing');
        }
    }

    // Rule 3 — engine, when present, must be a string that DECLARES its version.
    // COMPATIBILITY reading, never vetting: a hostile bundle declares a false constant as easily as
    // it stamped a false header. The capability block is the security boundary, not this.
    if (pack.engine !== undefined) {
        if (typeof pack.engine !== 'string' || !pack.engine.trim()) {
            errors.push('rule 3: "engine" must be the engine JS as one string');
        } else if (!declaredVersionOf(pack.engine)) {
            errors.push('rule 3: the "engine" text declares no version — add `const ENGINE_VERSION = "v<major>.<minor>[.patch]"` and export it, so upgrades and the reload line can name what is running');
        }
    }

    // Rule 5 — the derived-format cross-check: declaring an old format while carrying a section
    // that needs a newer one is an ERROR naming the section and the number to write.
    if (typeof pack.format === 'string' && fmtParts(pack.format)) {
        for (const key of Object.keys(table)) {
            if (pack[key] !== undefined && fmtLess(pack.format, table[key])) {
                errors.push('rule 5: section "' + key + '" needs format ' + table[key] + ' but the file declares ' + pack.format + ' — declare "format": "' + requiredFormat(pack, table) + '"');
            }
        }
    }

    // Rule 6 — the layout is 100% declarative; every customLogic site is named.
    if (pack.layout !== undefined) {
        if (!pack.layout || typeof pack.layout !== 'object') {
            errors.push('rule 1: "layout", when present, must be an object');
        } else {
            for (const site of findCustomLogicSites(pack.layout)) {
                errors.push('rule 6: layout carries "customLogic" at ' + site + ' — logic belongs in the StatusMenu Engine\'s formatters; the layout is 100% declarative');
            }
        }
    }
    // Rule 6, the `panel` half — same stance as the layout: the host reads `kind` + `format` and carries
    // the rest verbatim, so those two are the whole shape check, and `customLogic` is refused for the
    // reason it is refused in a layout.
    if (pack.panel !== undefined) {
        if (!pack.panel || typeof pack.panel !== 'object' || Array.isArray(pack.panel)) {
            errors.push('rule 1: "panel", when present, must be an object');
        } else {
            for (const field of ['kind', 'format']) {
                if (typeof pack.panel[field] !== 'string' || !pack.panel[field].trim()) {
                    errors.push('rule 1: "panel" must carry a string "' + field + '" — the host reads exactly that to choose a renderer');
                }
            }
            for (const site of findCustomLogicSites(pack.panel)) {
                errors.push('rule 6: panel carries "customLogic" at ' + site + ' — logic belongs in the Plugin Engine (renderPanel); the panel is 100% declarative');
            }
        }
    }

    // Rule 7 — the schema must not let Zod STRIP platform state. The only namespace rule a GameLogic Pack
    // faces: a game owns all of stat_data except the platform roots (PLATFORM_ROOT_NAMES), whose keys are
    // chosen by mvu-helper and by whoever installs a plugin, so they are protected where they can be harmed
    // — in the Zod schema. A schema may declare them (so tooling sees them); the hazard is their SHAPE: a
    // closed declaration strips every key it does not name on the next write that applies a command. An
    // OPEN form is accepted, a closed one refused, naming the forms that work.
    if (pack.schema === undefined) {
        // A PLUGIN owes one: on a card with no schema at all, MVU's own derived schema freezes the
        // plugin's empty drawer, and the plugin installs perfectly and then writes nothing. The author
        // cannot know which kind of card it lands on, so every plugin carries a schema and the INSTALLER
        // decides whether the card needs it (decidePluginSchemaInstall).
        if (pack.packType === 'plugin') {
            errors.push('rule 7: a "plugin" file must ship a "schema" section declaring "' + PLUGIN_ROOT_NAME
                + '" OPEN (' + OPEN_FORMS.join(' / ') + '). Without one, installing onto a card that has no'
                + " GameLogic Pack leaves MVU's own derived schema in charge, and it freezes this plugin's drawer"
                + ' to the keys it held when MVU derived it — none. Install skips it on cards that already have a schema');
        }
    } else {
        if (typeof pack.schema !== 'string' || !pack.schema.trim()) {
            errors.push('rule 1: "schema", when present, must be the registerMvuSchema script as one string');
        } else if (pack.packType === 'plugin' && !pack.schema.includes(PLUGIN_ROOT_NAME)) {
            errors.push('rule 7: a "plugin" schema must DECLARE "' + PLUGIN_ROOT_NAME + '" — that root is the only thing'
                + ' it exists to declare, and one that omits it leaves a standalone card exactly as frozen as no schema'
                + ' at all. Declare it open (' + OPEN_FORMS.join(' / ') + ')');
        } else if (isRegisteredRootClosed(pack.schema) && (pack.packType === 'plugin' || !declaresEveryPlatformRootOpenly(pack.schema))) {
            // Rule 7b — the ROOT's own shape, a different question from rule 7's (that one asks about
            // a platform root INSIDE the root). `z.object` drops every key it was never told about from the
            // copy it parses, and no artifact is the only writer on a card: mvu-helper keeps its own root and
            // GameLogicPlugin, a plugin names its own drawer, a game pack names game roots. So under a closed
            // root every command into a root it does not describe is dropped, with nothing in any log, and
            // how much more is lost is up to mvu_zod, which is loaded unpinned and has changed before.
            //
            // mvu_zod re-wraps a registered root as looseObject, but only a root that is `instanceof
            // z.ZodObject`: a bare closed root is rescued, a `.prefault({})`-wrapped one (a ZodPrefault)
            // is not (zod 4.4.3). Either is refused: the rule reads the schema as WRITTEN, because a root
            // that is safe only while an external bridge patches it is one edit away from not being.
            //
            // Closing the root on purpose is a game card's call — freezing the top level so nobody can
            // invent `stat_data.<key>` at will. So a closed root is refused only when the state it would
            // lose has no other protection: a game pack that also declares every platform root open is
            // warned instead (below). A PLUGIN is refused either way: it never owns the root, and a
            // plugin closing it strips the whole game.
            var closedForm = registeredRootShape(pack.schema).baseForm;
            errors.push('rule 7b: the registered root is `z.' + closedForm + '(…)`, which '
                + CLOSED_ROOT_FAILURE[closedForm] + ' — including mvu-helper\'s own ' + PLATFORM_ROOT_LIST
                + ' and any installed plugin\'s state. Declare the root open'
                + ' (`z.looseObject({…})`, or chain `.passthrough()` or `.catchall(z.any())` onto it)'
                + (pack.packType === 'plugin' ? '. A plugin never owns the root: closing it strips the whole game'
                    : '; or, if closing it is deliberate, declare ' + PLATFORM_ROOT_LIST + ' inside it, each as'
                      + ' z.record(z.string(), z.any())')
                + '. Do not leave it to mvu_zod: it does re-wrap a registered root as looseObject, but only'
                + ' while the root is `instanceof z.ZodObject` — wrap it in anything (`.prefault({})` is the'
                + ' usual one) and the rewrap stops firing and the loss above is what happens. A root that'
                + ' needs that bridge to be safe is one edit away from not being.');
        } else {
            for (const name of PLATFORM_ROOT_NAMES) {
                if (rootDeclarationAt(pack.schema, name) < 0 || declaresRootOpenly(pack.schema, name)) continue;
                errors.push('rule 7: the schema declares "' + name + '" with a CLOSED shape — Zod would strip'
                    + ' every key it does not name on the next write, and ' + PLATFORM_ROOT_KEYS_OWNER[name] + '.'
                    + ' Declare it open (' + OPEN_FORMS.join(' / ') + '), or leave the root out entirely —'
                    + ' looseObject passes an undeclared root through untouched');
            }
        }
        if (typeof pack.schema === 'string' && pack.packType !== 'plugin'
            && isRegisteredRootClosed(pack.schema) && declaresEveryPlatformRootOpenly(pack.schema)) {
            var lockedForm = registeredRootShape(pack.schema).baseForm;
            warnings.push('rule 7b: the registered root is CLOSED (`z.' + lockedForm + '(…)`) — a deliberate'
                + ' lock, and ' + PLATFORM_ROOT_LIST + ' are declared open, so mvu-helper and its plugins keep their'
                + ' state. Every OTHER root that arrives later is lost as soon as the root is wrapped in'
                + ' anything (`.prefault({})` is the usual one, and it stops mvu_zod re-wrapping the root as'
                + ' looseObject): it ' + CLOSED_ROOT_FAILURE[lockedForm]
                + '. Only lock the root on a card whose roots you own in full');
        }
    }

    // Rule 8 — `requires` / `optionalUses` carry interface NAMES. See isInterfaceName for why the
    // shape is checked here and not left to the matcher: a malformed name cannot match, and the failure
    // it produces at install time accuses the wrong side.
    for (const field of ['requires', 'optionalUses']) {
        if (pack[field] === undefined) continue;
        if (!Array.isArray(pack[field])) {
            errors.push('rule 8: "' + field + '", when present, must be an ARRAY of interface names (e.g. ["cast@1"]) — got ' + JSON.stringify(pack[field]));
            continue;
        }
        pack[field].forEach((value, i) => {
            if (!isInterfaceName(value)) {
                errors.push('rule 8: ' + field + '[' + i + '] is ' + JSON.stringify(value)
                    + ' — an interface name is "<name>@<major>": lowercase name, then @ and a major number (e.g. "cast@1")');
            }
        });
    }

    // Rule 13 — `exposes` (gamelogic): the GAME's side of the interface contract, a map of
    // interface name → the pack's OWN dotted stat_data path ({"cast@1": "Classmate"}). Checked with
    // the same reasoning as rule 8 on the plugin side: the broker is a blind string matcher, so a
    // malformed entry here would surface later as an install refusal that blames the PLUGIN for the
    // pack author's typo.
    if (pack.exposes !== undefined) {
        if (!pack.exposes || typeof pack.exposes !== 'object' || Array.isArray(pack.exposes)) {
            errors.push('rule 13: "exposes", when present, must be an OBJECT mapping interface names to this pack\'s own dotted stat_data paths ({"cast@1": "YourCastRoot"}) — got ' + JSON.stringify(pack.exposes));
        } else {
            for (const [name, path] of Object.entries(pack.exposes)) {
                if (!isInterfaceName(name)) {
                    errors.push('rule 13: exposes key ' + JSON.stringify(name) + ' is not an interface name — "<name>@<major>": lowercase name, then @ and a major number (e.g. "cast@1")');
                }
                if (typeof path !== 'string' || !/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/.test(path)) {
                    errors.push('rule 13: exposes["' + name + '"] must be a dotted stat_data path ("YourCastRoot", "YourRoot.Events") — got ' + JSON.stringify(path));
                }
            }
        }
    }

    // Rule 9 — an unsubstituted token reaches the PROMPT verbatim. WARN, never refuse: prose we do not
    // own may legitimately contain braces, and blocking an install over the plugin's own prompt text
    // would be the platform overreaching on a guess. Plugin-only — the token vocabulary is the plugin
    // installer's, so scanning a gamelogic pack's prompt text for it would invent warnings about someone
    // else's prose.
    if (pack.packType === 'plugin') {
        for (const token of unknownPluginTokens(pack)) {
            warnings.push('rule 9: entries contain ' + token + ', which the installer does not substitute — it would reach the prompt verbatim. Known tokens: ' + PLUGIN_TOKENS.join(' · '));
        }
    }

    // Rule 10 — the `regex` section. Identity is `script_name`, so two of the things checked here are
    // the two that make an install un-undoable: a regex with no name can never be removed by name, and two
    // regexes sharing a name make "remove ours" ambiguous — uninstall would take the card's copy or leave
    // ours, with no way to tell which. The third is what a GAMELOGIC row may put on screen: TavernHelper
    // renders any message text carrying one of its frontend tokens (isTavernHelperFrontendText) as an
    // unsandboxed iframe holding the page's SillyTavern context, Mvu and every TavernHelper function — pack
    // code with the page's full reach. A StatusMenu Pack's rows are exempt only because their own install
    // lifts each fenced document into the contained frame and refuses whatever is left (statusmenu-pack-core
    // liftMenuRegexRows); a GameLogic Pack has no such lane, so its row is refused outright. Checked on every
    // row whatever its destination flags, as the StatusMenu invariant is: a flag is the card owner's to
    // flip after install. Everything else about a regex has an inert default (normalizeTavernRegex), so
    // demanding it here would only refuse packs that meant no harm.
    if (pack.regex !== undefined) {
        if (!Array.isArray(pack.regex)) {
            errors.push('rule 10: "regex", when present, must be an ARRAY of TavernHelper regex objects (script_name / find_regex / …) — got ' + JSON.stringify(pack.regex));
        } else {
            const seen = new Map();
            pack.regex.forEach((r, i) => {
                if (!r || typeof r !== 'object' || Array.isArray(r)) {
                    errors.push('rule 10: regex[' + i + '] must be an object');
                    return;
                }
                const name = typeof r.script_name === 'string' ? r.script_name.trim() : '';
                if (!name) {
                    errors.push('rule 10: regex[' + i + '] needs a non-empty string "script_name" — it is the regex\'s IDENTITY here (uninstall and upgrade both find it by name; ST\'s own `id` is per-installation and cannot be matched across cards)');
                } else if (seen.has(name)) {
                    errors.push('rule 10: regex[' + i + '] repeats script_name "' + name + '" (already at regex[' + seen.get(name) + ']) — names must be unique, or uninstall cannot tell which one it owns');
                } else {
                    seen.set(name, i);
                }
                if (typeof r.find_regex !== 'string' || !r.find_regex.trim()) {
                    errors.push('rule 10: regex[' + i + ']' + (name ? ' ("' + name + '")' : '') + ' needs a non-empty string "find_regex"');
                } else if (!compilesAsTavernRegex(r.find_regex)) {
                    // WARN, not refuse: this reimplements ST's /pattern/flags parse, so a refusal here could
                    // be OUR parser's limit rather than the author's mistake. A pattern ST accepts and we
                    // cannot read must not block an install — but it is worth saying, because the usual
                    // cause is a real typo and the symptom on the card is a regex that silently never fires.
                    warnings.push('rule 10: regex[' + i + ']' + (name ? ' ("' + name + '")' : '') + ' — "find_regex" did not compile as /pattern/flags; ST may not apply it. Check the delimiters and escaping');
                }
                if (pack.packType === 'gamelogic' && isTavernHelperFrontendText(r.replace_string)) {
                    const token = TAVERNHELPER_FRONTEND_TOKENS.find((t) => String(r.replace_string).includes(t));
                    errors.push('rule 10: regex[' + i + ']' + (name ? ' ("' + name + '")' : '') + ' — "replace_string" carries ' + JSON.stringify(token)
                        + ", so TavernHelper would render it as a web page with the page's full reach (SillyTavern's context, Mvu, every TavernHelper function). A GameLogic Pack's regexes may hide or restyle the game's output, never render a document: ship it in a StatusMenu Pack, whose install moves it into a contained frame");
                }
                // "Intended?" is a question only the AUTHOR can answer, and the platform stays blind to
                // WHY — so the answer is a declaration on the regex itself: `prompt_rewrite_intended: true`
                // silences the warning, and normalizeTavernRegex never carries it to ST (it rebuilds from
                // an explicit field list). Asking a question forever after it was answered is stale noise,
                // and stale noise is how real warnings get ignored.
                const promptSide = r.destination && typeof r.destination === 'object' && r.destination.prompt === true;
                if (promptSide && r.prompt_rewrite_intended !== true) {
                    // Not an error — a prompt-side regex is legitimate. But it edits what the MODEL reads
                    // rather than what the user sees, so an author who set it by copying a display regex
                    // should find out at import and not from a turn that behaves strangely.
                    warnings.push('rule 10: regex[' + (name ? '"' + name + '"' : i) + '] sets destination.prompt — it will rewrite text on its way to the MODEL, not just on screen. If it is meant to, declare prompt_rewrite_intended: true on this regex');
                } else if (!promptSide && 'prompt_rewrite_intended' in r) {
                    // The stale half: a declaration outliving the destination it acknowledged would read
                    // as current to the next editor (the litmus: seeing ONLY this regex, would they be
                    // correct?). Named, never silently ignored.
                    warnings.push('rule 10: regex[' + (name ? '"' + name + '"' : i) + '] declares prompt_rewrite_intended but does not set destination.prompt — the declaration answers a question nothing is asking; remove it');
                }
            });
        }
    }

    // Rule 14 — `regexOrder`: the pack's OWN internal apply order, an array of the script_names its
    // `regex` section ships. Regexes execute in list order, each transforming the previous one's output,
    // so relative order among a pack's regexes is part of what the pack IS — and without this section
    // install keeps every known name in the slot it already has, so a released pack that reorders its
    // regexes silently does not. Two-way complete, like engineOrder and for the same reason: a name
    // outside the listing is a row whose position the declaration silently does not govern, which is the
    // exact ambiguity the section exists to end.
    if (pack.regexOrder !== undefined) {
        if (!Array.isArray(pack.regexOrder) || pack.regexOrder.some((n) => typeof n !== 'string' || !n.trim())) {
            errors.push('rule 14: "regexOrder", when present, must be an ARRAY of non-empty script_name strings — got ' + JSON.stringify(pack.regexOrder));
        } else {
            const shipped = new Set((Array.isArray(pack.regex) ? pack.regex : []).map((r) => String((r && r.script_name) || '')).filter(Boolean));
            const listed = new Set();
            pack.regexOrder.forEach((name, i) => {
                if (listed.has(name)) errors.push('rule 14: regexOrder[' + i + '] repeats "' + name + '" — a name cannot hold two positions');
                listed.add(name);
                if (!shipped.has(name)) errors.push('rule 14: regexOrder names "' + name + '", which is not in this pack\'s regex section');
            });
            for (const name of shipped) {
                if (!listed.has(name)) errors.push('rule 14: regex "' + name + '" is not named in regexOrder — its position would silently not be governed by the declaration');
            }
            if (!Array.isArray(pack.regex) || !pack.regex.length) {
                errors.push('rule 14: "regexOrder" without a "regex" section orders nothing — remove it, or ship the regexes it names');
            }
        }
    }

    // Rule 11 — the `state` section: { version, force, forceFromInitVar }. `force` maps absolute dotted paths to the
    // values card-sync writes over a running save; `forceFromInitVar` lists dotted paths that take the card's own
    // [InitVar] value instead, so the card carries one copy. `version` gates both against the save's watermark, so a
    // correction applies once per version. The seed is never here: it is the card's own [InitVar] entry, which
    // card-sync re-applies create-only on every chat load. `seed`, `data` and a top-level `init` are refused by
    // name, because each would look applied while nothing reads it.
    if (pack.state !== undefined) {
        const st = pack.state;
        if (!st || typeof st !== 'object' || Array.isArray(st)) {
            errors.push('rule 11: "state", when present, must be an object { version, force, forceFromInitVar }');
        } else {
            if (!isVersionString(st.version)) {
                errors.push('rule 11: "state.version" is REQUIRED, as M.m or M.m.r — numbers only, e.g. "1.0.0" (got '
                    + JSON.stringify(st.version) + '). It gates `force` and `forceFromInitVar` against the save\'s watermark; without a version that compares, a correction re-applies on every load');
            }
            if (st.force !== undefined && (!st.force || typeof st.force !== 'object' || Array.isArray(st.force))) {
                errors.push('rule 11: "state.force", when present, must be an object — a FLAT map of absolute dotted path to value ({"World.Weather": ["Clear","天氣"]})');
            }
            if (st.forceFromInitVar !== undefined) {
                if (!Array.isArray(st.forceFromInitVar)) {
                    errors.push('rule 11: "state.forceFromInitVar", when present, must be a list of absolute dotted paths (["EventPack.triggers"]) — each takes the card\'s own [InitVar] value there');
                } else {
                    st.forceFromInitVar.forEach((path, i) => {
                        if (typeof path !== 'string' || !path || !path.split('.').every(Boolean)) {
                            errors.push('rule 11: state.forceFromInitVar[' + i + '] must be an absolute dotted path such as "EventPack.triggers" (got ' + JSON.stringify(path) + ')');
                        }
                    });
                }
            }
            if (st.seed !== undefined) {
                errors.push('rule 11: "state.seed" is not a state field — the seed is the card\'s own [InitVar] entry, which mvu-helper re-applies to a running save on every chat load (create-only, at every depth). Put the tree in [InitVar], like any MVU card, and delete this field');
            }
            if (st.data !== undefined) {
                errors.push('rule 11: "state.data" is not a state field — the seed is the card\'s own [InitVar] entry, and overwrites of values already present go in "state.force" as a flat dotted-path map');
            }
        }
    }
    if (pack.init !== undefined) {
        errors.push('rule 11: a pack ships no "init" section — the seed is the card\'s own [InitVar] entry (the MVU standard), which mvu-helper re-applies to running saves; overwrites of values already present go in "state.force"');
    }

    // There is no rule 12. The installer's section entries (`[<Prefix>:<id>:Engine]` and kin) live inside
    // the control prefix rule 4 already refuses, so nothing reserves them by name.
    return { ok: errors.length === 0, errors, warnings, unknownSections, declaredFormat: String(pack.format || ''), supportedFormat: supported };
}

// `pack.state` is RECORDED in the pack registry, never written as a lorebook entry. `force` and
// `forceFromInitVar` are the one thing neither [InitVar] nor Zod can do — overwrite a value that is already
// PRESENT and wrong — and they must live on the CARD so they outlive the library file; the registry already
// does, and uninstall already deletes it.
export function packStateRecord(pack) {
    const state = (pack && pack.state && typeof pack.state === 'object') ? pack.state : null;
    if (!state) return { stateVersion: '', force: {}, forceFromInitVar: [] };
    return {
        stateVersion: String(state.version == null ? '' : state.version).trim(),
        force: (state.force && typeof state.force === 'object' && !Array.isArray(state.force)) ? state.force : {},
        forceFromInitVar: Array.isArray(state.forceFromInitVar) ? state.forceFromInitVar.map(String) : [],
    };
}

// What card-sync's force half takes from the card's registry: the state version and both force lists. null when no
// pack is active, which is the ordinary case for a card that just has mvu-helper installed.
export function packForcePayload(registry) {
    if (!registry || !registry.activePackId) return null;
    return { version: registry.stateVersion || '', force: registry.force || {}, forceFromInitVar: registry.forceFromInitVar || [] };
}

// Did MVU derive its schema BEFORE this pack existed? Pure, because it is a decision and the file that
// would otherwise host it cannot be opened by a test (L6).
//
// THE SHAPE OF THE PROBLEM, and it is MVU's design rather than a defect: MVU reads a book's [InitVar]
// ONCE — it records the book in `initialized_lorebooks` and never re-reads it — and it derives its
// schema from whatever stat_data existed at that moment. A pack can only be installed onto a CURRENT
// character, and selecting a character opens a chat, so on a freshly imported card MVU has always
// already run by the time the pack arrives. Its schema is therefore derived from an empty save.
//
// WHAT THAT COSTS, stated precisely because the obvious guess is backwards: MVU consults the schema
// only to REFUSE a write (`if (schemaNode) { if (!extensible) refuse }`). No node resolves in an empty
// schema, so nothing is refused — such a chat is MORE permissive, not broken. The hazard is the
// asymmetry: a chat created LATER, with the pack already in the book, gets the real derived schema and
// is stricter. Content proved in every chat the normal upgrade workflow produces can fail in one a
// player happens to create second, and nothing says so.
//
// WE SURFACE IT, WE DO NOT REPAIR IT (L7). Forcing a re-init means writing into MVU's own namespace
// through internals it does not export, which would leave this module permanently responsible for
// another's lifecycle.
//
// ⚠ AND IT IS MOOT FOR ANY PACK THAT SHIPS A SCHEMA, which is why the `schema` check comes first.
// A `schema` section is a Zod registration (mvu_zod.js), and that library takes MVU's validation over
// wholesale — it applies the parsed commands itself, empties MVU's command list so they cannot be
// applied twice, and then OVERWRITES MVU's schema with MVU's own disable sentinel:
//     eventOn('mag_command_parsed_ended_for_zod', (_t, cmds) => { cmds.length = 0 })
//     eventOn('mag_variable_update_ended_for_zod', v => { _.set(v, 'schema', '<disable sentinel>') })
// So on such a card MVU's derived schema is destroyed by design on the first update, a lagged one and
// a fresh one end up identical, and warning about the difference would describe a difference that does
// not exist.
// WHAT THE PACK SHIPS IS READ HERE, from the pack itself, rather than by the caller: the caller lives in
// a host-coupled file no test can open, so a reading there could break with no test failing (L6: audit
// what the untestable file DECIDES, not only what it names).
export function decideMvuSchemaLag({
    pack, bookName, initializedBooks, schemaPropertyCount,
} = {}) {
    const file = (pack && typeof pack === 'object') ? pack : {};
    if (file.schema !== undefined) return { lagged: false, reason: 'the pack ships a Zod schema, which replaces MVU\'s own with its disable sentinel — MVU\'s derived schema is moot on this card' };
    const packShipsInitVar = (planInstallEntries(file).entries || [])
        .some((e) => /\[InitVar\]/i.test(String(e.comment || '')));
    if (!packShipsInitVar) return { lagged: false, reason: 'the pack ships no [InitVar] entry — MVU has no schema to derive from it' };
    if (!bookName) return { lagged: false, reason: 'no book name — nothing can be claimed either way' };
    // `undefined` means "we could not read it". Absent-but-readable is `{}`, which IS an answer.
    if (!initializedBooks || typeof initializedBooks !== 'object') return { lagged: false, reason: 'MVU\'s initialized_lorebooks is unreadable — nothing can be claimed either way' };
    if (!Object.prototype.hasOwnProperty.call(initializedBooks, String(bookName))) {
        return { lagged: false, reason: 'MVU has not read this book yet — it will pick the pack\'s [InitVar] up when it initialises' };
    }
    if (typeof schemaPropertyCount !== 'number') return { lagged: false, reason: 'MVU\'s schema is unreadable — nothing can be claimed either way' };
    if (schemaPropertyCount > 0) return { lagged: false, reason: 'MVU has read this book and derived a schema' };
    return {
        lagged: true,
        reason: 'MVU read "' + bookName + '" before this pack was installed, so it derived its schema from an empty save',
    };
}

// Would ST accept this `find_regex`? A PORT of ST's own `regexFromString` (public/scripts/utils.js), not
// an approximation of it: ST's parse makes the delimiters OPTIONAL (`(\/?)`), so a bare pattern like
// `<StatusPlaceHolderImpl/>` is perfectly valid and is exactly what the School v4 menu regexes use. A
// check that demanded `/pattern/flags` would warn on every one of them.
//
// Returns true iff ST would end up with a RegExp; never throws.
function compilesAsTavernRegex(text) {
    const input = String(text || '');
    const m = input.match(/(\/?)(.+)\1([a-z]*)/i);
    if (!m) return false;
    try {
        // ST's own escape hatch: flags it does not recognise mean the whole string was never a
        // /pattern/flags form, so it compiles the input verbatim instead.
        if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) { new RegExp(input); return true; }
        new RegExp(m[2], m[3]);
        return true;
    } catch (_e) { return false; }   // EXPECTED: an author's typo — the caller warns, never refuses
}

// THE ONE JUDGEMENT every way a pack enters the library or reaches a card goes through: a folder or ZIP
// import, the dev loop, a pasted or loaded file, a library add, and an install from the library (the
// library entry is hand-editable, so an install judges it again). First the schema allow-list: install
// writes `schema` as page code, so everything off the list is REMOVED (gamelogic-pack-schema-allowlist.js)
// and what is judged from there on is the filtered pack. Then the validator, then the source gates
// (gateArtifactSource) — a StatusMenu Engine's exports are read first, in a Worker, through the caller's
// `readMenuEngine`. Required whenever a menu ships an engine, with no default, so no caller can end up
// running a picked engine on the page by leaving it out. Returns validatePack's report with the gates'
// findings merged in, plus `pack` — the filtered pack, the one every caller stores and installs — and
// `schemaRemovals` (also listed as warnings), which the import and install toasts read.
export async function judgePack(pack, { readMenuEngine, ...opts } = {}) {
    const allowed = withAllowedSchema(pack);
    const judged = allowed.pack;
    const v = validatePack(judged, opts);
    const menuEngineText = menuEngineTextToRead(judged);
    if (menuEngineText !== null && typeof readMenuEngine !== 'function') {
        throw new Error('judgePack: "' + String((judged && judged.id) || '?') + '" ships a menu engine, and no readMenuEngine was given to read it in a Worker');
    }
    const menuEngineExports = menuEngineText !== null ? await readMenuEngine(menuEngineText) : null;
    const g = gateArtifactSource(judged, { menuEngineExports });
    const errors = [...allowed.errors, ...v.errors, ...g.errors];
    return {
        ...v, ok: errors.length === 0, errors,
        warnings: [...allowed.warnings, ...v.warnings, ...g.warnings],
        pack: judged, schemaRemovals: allowed.removals,
    };
}

// The pack with its schema passed through the allow-list. A schema that is not a string is left as it is,
// for rule 1 to refuse.
function withAllowedSchema(pack) {
    if (!pack || typeof pack.schema !== 'string') return { pack, removals: [], errors: [], warnings: [] };
    const filtered = filterSchemaScript(pack.schema);
    const warnings = filtered.removals.map((r) => 'schema line ' + r.line + ': removed ' + r.what + ' — ' + r.why);
    if (filtered.text === null) {
        return { pack, removals: filtered.removals, errors: ['rule 1: ' + filtered.failure], warnings };
    }
    if (filtered.removals.length && !filtered.isRegistered) {
        warnings.push('schema: with those removed, nothing in it calls registerMvuSchema, so it registers no schema');
    }
    return {
        pack: filtered.text === pack.schema ? pack : { ...pack, schema: filtered.text },
        removals: filtered.removals, errors: [], warnings,
    };
}

// The toast for a judged pack whose schema lost something to the allow-list; '' when it lost nothing.
// A toast of its own, like the unknown-section one: what it reports did not install, and an author may
// read only the green line. `lead` names the moment ('Valid', 'Added', 'Installed', or the pack's name).
export function schemaRemovalToastText(res, lead) {
    const removals = (res && res.schemaRemovals) || [];
    if (!removals.length) return '';
    return lead + ' — ' + removals.length + ' part' + (removals.length > 1 ? 's' : '')
        + ' of the schema removed: not on the schema allow-list (schema line '
        + removals.map((r) => r.line).join(', ') + '). The rest of the schema installs.';
}

// judgePack on a file's text. Returns the report plus the judged `pack`; a JSON failure reports as the
// single rule-1-level error, with the same keys, so a caller never has to test for their absence.
export async function judgePackFile(text, opts = {}) {
    const { pack, error } = parsePackFile(text);
    if (!pack) return { ok: false, pack: null, errors: [error], warnings: [], schemaRemovals: [], unknownSections: [], declaredFormat: '', supportedFormat: supportedFormat(opts.sectionMinFormat || SECTION_MIN_FORMAT) };
    return judgePack(pack, opts);
}

// ═══ activation (registry · lifecycle · init · conflict) ═════════════════════

// ── the per-card registry ────────────────────────────────────────────────────

// `[GameLogicPack:Registry]` in the card's standalone book — ONE record, because one GameLogic Pack is
// active per card. Shape:
//   { activePackId, ver, installedComments: [..], engineOwned, engineFingerprint, schemaOwned, schemaFingerprint,
//     installedRegexNames: [..], stateVersion, force, forceFromInitVar, exposes, name, description, format, builtWith?,
//     regexOrder?, installedAt }
//   • engineOwned / schemaOwned — did THIS pack write the [MVU_LogicEngine] entry / the `Scheme`
//     script? Uninstall deletes only what the pack owns.
//   • engineFingerprint / schemaFingerprint — the slotFingerprint of the text the install wrote into each, so the
//     card row can tell the pack's copy from one another writer put there (packOwnedSlots).
//   • installedRegexNames — a LIST, not an owned boolean: a pack writes N regexes into a list the CARD
//     also uses, so ownership is per NAME. It is also the only handle uninstall has, since a regex
//     carries no comment prefix to sweep by.
//   • stateVersion + force + forceFromInitVar — the `state` section, recorded here so it lives on the card and
//     outlives the library file; card-sync applies both force lists once per `stateVersion` against the save's
//     watermark (readActiveForcePayload). The SEED is not recorded: it is the card's own [InitVar], read from the
//     book itself.
//   • exposes — the interface map, recorded for the same reason: a plugin's `requires` still resolves
//     after the library file is gone.
//   • name / description / format / builtWith / regexOrder — the artifact's identity and declared
//     regex order, which the export reads back.
//
// There is no root list. A GameLogic Pack is the game engine and its Zod schema spans every root it uses,
// so a root list could only mean "all of stat_data" — uninstall offering to delete the save.
// Uninstall removes what the pack ADDED (entries, owned engine, owned schema, its regexes) and stops
// there. A pack type that owns a FENCED subtree (plugins) derives its root from its own id and
// purges it in its own uninstall.
export function packRegistryComment(packType) {
    return libraryEntryComment(packType, 'Registry');
}
export function packRegistryMatch(packType) {
    return packRegistryComment(packType).toLowerCase();
}

// Parse the registry entry's content ('#' header lines tolerated — the event-pack convention). THROWS
// on malformed JSON: a broken registry must never be read as "no pack active", because acting on that
// (a sweep, an init skip) would be destructive off a typo. Callers catch, report, and STAND DOWN.
export function parsePackRegistry(raw) {
    // 'null' for an EMPTY body, not '{}': this registry holds ONE active record, so an empty entry is
    // "no pack active" — which the shape check below then names. (event-pack's registry is a MAP and
    // empties to '{}'; the two defaults are not interchangeable, hence the explicit argument.)
    const obj = parseRegistryJson(raw, { whenEmpty: 'null' });
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('the pack registry must be a JSON object');
    if (typeof obj.activePackId !== 'string' || !obj.activePackId) throw new Error('the pack registry has no "activePackId"');
    return {
        activePackId: obj.activePackId,
        ver: String(obj.ver == null ? '0' : obj.ver),
        installedComments: Array.isArray(obj.installedComments) ? obj.installedComments.map(String) : [],
        engineOwned: obj.engineOwned === true,
        schemaOwned: obj.schemaOwned === true,
        // What the install wrote into each owned slot, as its slotFingerprint. Absent reads as '', which matches no text.
        engineFingerprint: String(obj.engineFingerprint || ''),
        schemaFingerprint: String(obj.schemaFingerprint || ''),
        // The `state` section's two FORCE lists and the version that gates them against the save's watermark.
        // The SEED is not here: it is the card's [InitVar], read from the book itself.
        stateVersion: String(obj.stateVersion == null ? '' : obj.stateVersion),
        force: (obj.force && typeof obj.force === 'object' && !Array.isArray(obj.force)) ? obj.force : {},
        forceFromInitVar: Array.isArray(obj.forceFromInitVar) ? obj.forceFromInitVar.map(String) : [],
        // The regex names THIS pack wrote: the only handle uninstall has, and what tells a repair of
        // our own regexes from overwriting the card's. Absent reads as "this pack installed none".
        installedRegexNames: Array.isArray(obj.installedRegexNames) ? obj.installedRegexNames.map(String) : [],
        // The pack's interface map ({"cast@1": "YourCastRoot"}), recorded verbatim at activation so
        // a plugin's `requires` still resolves after the library file is gone. Absent reads as "exposes
        // nothing".
        exposes: (obj.exposes && typeof obj.exposes === 'object' && !Array.isArray(obj.exposes)) ? obj.exposes : {},
        // What the artifact is CALLED, carried through the parse so the export can read it back. Absent
        // fields read as empty strings, never an error.
        ...artifactIdentityRecord(obj),
        ...(Array.isArray(obj.regexOrder) ? { regexOrder: obj.regexOrder.map(String) } : {}),
        installedAt: String(obj.installedAt || ''),
    };
}

// Serialize for the registry entry (round-trips through parsePackRegistry — the '#' header line is
// stripped by its comment tolerance).
export function buildPackRegistryContent(packType, registry) {
    return buildRegistryText(packRegistryComment(packType), 'GameLogic Packs', registry);
}

// The pack's owned slots, for the card row's LED (shared/card-artifact-store.js deriveArtifactLed): the [MVU_LogicEngine]
// entry and the `Scheme` script, each with the fingerprint the registry recorded and the text the card holds now
// (readCardPackState). The schema is read through TavernHelper's script API, so while that is detached its text is
// undefined (could not look), never null (empty).
export function packOwnedSlots(registry, { cardEngineText = null, cardSchemeText = null, scriptApiUp = false } = {}) {
    return [
        { name: '[MVU_LogicEngine]', isOwned: registry.engineOwned === true, recordedFingerprint: registry.engineFingerprint, text: cardEngineText },
        { name: SCHEMA_SCRIPT_NAME, isOwned: registry.schemaOwned === true, recordedFingerprint: registry.schemaFingerprint, text: scriptApiUp ? cardSchemeText : undefined },
    ];
}

// ── the activation decision ──────────────────────────────────────────────────

// What may this activation do, and what must it refuse? PURE — every input is a plain value the host
// glue reads first. Ordered: the cheapest total refusals come first, the per-piece conflicts after,
// because "no chat" must win over "engine conflict" (a conflict report against no card is noise).
//
//   state:
//     isCardOpen         — is a CARD open, or is this ST's lobby? Read from the selected character,
//                          never from the message count: the lobby carries a placeholder chat, so a
//                          count test says "chat open" with nothing loaded
//     areEntriesReadable — did the card's worldbook actually answer? Split from the guard above
//                          because a book that is merely still loading is NOT a missing chat, and
//                          saying so sends the user to fix something that is not broken
//     isChatStarted      — does the open card's chat have any messages? The in-chat guard; the two
//                          facts above only add refusals ahead of it, so no write path widens
//     pack             — the validated pack file object
//     registry         — parsePackRegistry() output, or null when the card has none
//     cardEngineText   — the [MVU_LogicEngine] entry's engine code, or null when there is no entry
//     cardSchemeText   — the character-scoped `Scheme` script's content, or null when there is none
//     cardRegexNames   — every character-scoped regex name currently on the card
//     unchangedRegexNames — of the pack's regexes, which the card ALREADY matches byte for byte; null
//                          when the card could not be read, which counts every clash as differing
//     allowAdopt       — the developer answered the adopt question YES for this card. Overwrites the
//                        unowned surfaces and records ownership; never set by an apply on its own
//
// Returns { action, reasons, claimed, adoptable } — action is one of:
//   'no-chat' · 'card-unreadable'
//   'needs-adopt' (an unowned surface DIFFERS — `adoptable` holds one dialog line per surface, which the
//                  adopt question lists; one Adopt clears it)
//   'activate' (nothing active) · 'repair' (same id, same ver — rewrite the pieces)
//   'upgrade' (same id, library newer)
//   'downgrade' (same id, library OLDER — allowed + warned; carries `installedVersion` and `libraryVersion`)
//   'switch-needed' (a DIFFERENT pack of this type is active — Switch is offered, never silent replace;
//                    carries `active`: { id, version } of the pack it would replace)
//
// `claimed` names every unowned surface whose bytes ALREADY equal what this pack would write. Those are
// adopted without asking, because writing them changes nothing on the card — the rule is that a pack
// never SILENTLY OVERWRITES what the user owns, and an identical write overwrites nothing. It is
// still reported so the claim is on the record: adoption makes the surface pack-owned, and uninstall
// deletes what it owns, so a card that arrived carrying a `Scheme` will lose it on the pack's uninstall.
export function decideActivation({ isCardOpen, isChatStarted, areEntriesReadable, bookBinding, bookName, pack, registry, cardEngineText, cardSchemeText, cardRegexNames, unchangedRegexNames, allowAdopt = false } = {}) {
    // The access verdict — lobby vs still-loading vs unstarted chat — is derived ONCE, in
    // cardAccessProblem (see its header for the one order that keeps every message truthful). This lane
    // only supplies its own wording, and the unreadable SENTENCE is shared too: three of the four reasons
    // a book does not answer never resolve, and each names a different action (cardUnreadableReason).
    const access = cardAccessProblem({ isCardOpen, isChatStarted, areEntriesReadable });
    if (access === 'no-chat') return { action: 'no-chat', reasons: ['open a chat first — activation writes to that card\'s worldbook and save'] };
    if (access === 'card-unreadable') {
        return { action: 'card-unreadable', reasons: [cardUnreadableReason({ binding: bookBinding, bookName })] };
    }

    // A surface the registry does not mark pack-owned is the CARD's own. Three outcomes,
    // not two (see unownedSurfaceVerdict): identical bytes are CLAIMED, different bytes ask once.
    const ownsEngine = Boolean(registry && registry.engineOwned);
    const ownsSchema = Boolean(registry && registry.schemaOwned);
    const claimed = [];
    const adoptable = [];
    // Both sizes on every conflict line, because the question this feeds is "replace what with what?"
    // and a name alone gives the developer nothing to decide with. Each conflict is a dialog line
    // (sillytavern/popup-core.js): fixed words keyed, the sizes and names as values.
    const sizes = (cardText, packText) => String(cardText || '').length + ' B → ' + String(packText || '').length + ' B';
    const engineVerdict = unownedSurfaceVerdict({ cardText: cardEngineText, packText: pack && pack.engine, owned: ownsEngine });
    if (engineVerdict === 'claim') claimed.push('the [MVU_LogicEngine] entry');
    if (engineVerdict === 'conflict') adoptable.push({ text: 'The [MVU_LogicEngine] entry, card → pack:', name: sizes(cardEngineText, pack && pack.engine) });
    const schemaVerdict = unownedSurfaceVerdict({ cardText: cardSchemeText, packText: pack && pack.schema, owned: ownsSchema });
    if (schemaVerdict === 'claim') claimed.push('the "Scheme" script');
    if (schemaVerdict === 'conflict') adoptable.push({ text: 'The "Scheme" script, card → pack:', name: sizes(cardSchemeText, pack && pack.schema) });
    // The same rule for regexes, with one difference that matters: a pack ships N of them into a list
    // the CARD also writes into, so ownership is per NAME rather than per surface. Only names the registry
    // did not record as ours count, which is what keeps repair/upgrade from colliding with its own install.
    if (pack && Array.isArray(pack.regex) && pack.regex.length) {
        const wanted = pack.regex.map((r) => String((r && r.script_name) || '')).filter(Boolean);
        const clash = conflictingRegexNames(cardRegexNames, wanted, registry && registry.installedRegexNames);
        // null means the card's scoped scripts could not be READ, and "could not look" must never read as
        // "nothing matches" — that direction claims nothing and asks, which is the recoverable mistake.
        const matches = new Set(Array.isArray(unchangedRegexNames) ? unchangedRegexNames.map(String) : []);
        const same = clash.filter((n) => matches.has(n));
        const differ = clash.filter((n) => !matches.has(n));
        if (same.length) claimed.push(same.length + ' regex' + (same.length === 1 ? '' : 'es') + ' already identical (' + same.map((n) => '"' + n + '"').join(', ') + ')');
        if (differ.length) {
            adoptable.push({ text: 'Regexes the pack writes differently:', name: differ.map((n) => '"' + n + '"').join(', ') });
        }
    }

    // The one refusal that survives adoption: bytes that DIFFER. It is not a failure and not a fault —
    // it is a question with one answer, so it is shaped like the plugin lane's setup step rather than
    // like a broken build (artifact-dev-loop-core.js isSetupRefusal reads 'needs-adopt' that way).
    if (adoptable.length && !allowAdopt) {
        return {
            action: 'needs-adopt',
            claimed,
            adoptable,
            reasons: ['this card owns ' + adoptable.length + ' surface' + (adoptable.length === 1 ? '' : 's')
                + ' the pack writes differently — ' + adoptable.map(dialogLineText).join(' · ')
                + '. The pack\'s Install button on the GameLogic Packs tab asks before replacing them; nothing is overwritten until then.'],
        };
    }

    if (!registry) return { action: 'activate', reasons: [], claimed, adoptable };
    if (registry.activePackId !== (pack && pack.id)) {
        return {
            action: 'switch-needed', claimed, adoptable, active: { id: registry.activePackId, version: registry.ver },
            reasons: ['"' + registry.activePackId + '" v' + registry.ver + ' is active on this card — Switch uninstalls it first, then installs this one; the chat\'s stat_data is untouched'],
        };
    }
    const libraryVersion = String((pack && pack.version) || '0');
    const c = compareVersions(libraryVersion, registry.ver);
    if (c > 0) return { action: 'upgrade', reasons: [], claimed, adoptable };
    if (c < 0) {
        return {
            action: 'downgrade', claimed, adoptable, installedVersion: registry.ver, libraryVersion,
            reasons: ['library v' + libraryVersion + ' is older than the installed v' + registry.ver],
        };
    }
    return { action: 'repair', reasons: [], claimed, adoptable };
}

// What may an activation do with a surface the registry does NOT record as this pack's?
//
// The rule is that a pack never SILENTLY OVERWRITES what the user owns. Reading it as "refuse whenever
// the registry is silent" is stricter than the rule and makes one whole class of card permanently
// un-activatable: a card BUILT from the same source the pack ships carries the pack's own `Scheme`,
// engine and regexes with no registry anywhere, so every activation would refuse against itself and the
// only exit would be a human deleting the script by hand.
//
//   'clear'    — nothing in the way: the pack ships no such surface, or the registry already records it as
//                ours, or the card simply has nothing there
//   'claim'    — the card HAS it, unowned, and its bytes ALREADY equal what this pack would write. Writing
//                it changes nothing, so there is nothing to overwrite and nothing to ask about
//   'conflict' — the card HAS it, unowned, and it DIFFERS. The only case that asks
//
// PURE, and the whole adoption decision lives here rather than in the three call sites, so all three
// surfaces answer the same question the same way.
export function unownedSurfaceVerdict({ cardText, packText, owned } = {}) {
    if (packText === undefined || packText === null) return 'clear';
    if (owned) return 'clear';
    if (cardText === undefined || cardText === null) return 'clear';
    return String(cardText) === String(packText) ? 'claim' : 'conflict';
}

// ── the write plan ───────────────────────────────────────────────────────────

// What the install warning reads of a GameLogic Pack (installReachTexts): its entries and its regex rows, which an
// install writes as the file has them, but for the comment prefix (planInstallEntries, below). The panel declaration's
// silent entry holds data for mvu-helper and is not read.
export function packReachTexts(pack) {
    return installReachTexts({ entries: pack && pack.entries, regexRows: pack && pack.regex });
}

// The exact card-book entries an activation writes. PURE and returned as data so the host glue is a
// dumb loop and byte-fidelity is decided HERE, testably:
//   • comment = "[GameLogicPack:<id>] " + the entry's own comment (the prefix — uninstall finds it,
//     ownership is visible in the ST editor);
//   • every OTHER field passes through VERBATIM (position, depth, keys, order, probability, …).
//     The format's example shows the minimal fields, but School's [PRE] entries live on position/depth/keys —
//     dropping unknown fields would install a pack that renders in the wrong place, which no validator
//     rule would ever catch (it is not malformed, just wrong).
//   • uid is STRIPPED: it is the source book's identity, and carrying it into createLorebookEntries
//     could collide with the destination book's own uids.
// Returns { entries, installedComments } — installedComments is the registry's uninstall list, recorded
// at write time rather than re-derived later (uninstallExactness checks the two ways of counting
// against each other).
export function planInstallEntries(pack) {
    const prefix = libraryEntryComment(pack.packType, pack.id) + ' ';
    const entries = [];
    const installedComments = [];
    // The `panel` declaration is planned AS AN ENTRY rather than through a write path of its own, and
    // that is the whole design: install, upgrade's pre-delete, uninstall's needle sweep, the exactness
    // count and the export walk are already entry machinery, so a declaration that IS an entry inherits
    // every one of them and adds no branch to any of them.
    const panelEntry = planPanelEntry(pack.packType, pack.id, pack.panel);
    if (panelEntry) {
        entries.push(panelEntry);
        installedComments.push(panelEntry.comment);
    }
    for (const entry of (Array.isArray(pack.entries) ? pack.entries : [])) {
        const { uid: _uid, ...fields } = entry;
        const comment = prefix + String(entry.comment || '');
        entries.push({ ...fields, comment });
        installedComments.push(comment);
    }
    // NOTHING is appended here for `state`. The payload is recorded in the registry (packStateRecord),
    // not written as an entry — see that function for why.
    return { entries, installedComments };
}

// installedSweepNeedle · preDeleteNeedles · uninstallExactness live in shared/card-artifact-store.js:
// all three are artifact-lifecycle machinery with nothing pack-file-specific in them, and event-pack's
// uninstall is the second consumer. Re-exported at the top of this file.

// ── init — create-only merge into stat_data ──────────────────────────────────

// mergeInitSubtree lives in shared/create-only-merge.js (P3): card-sync seeds the card's [InitVar] tree
// with it and the plugin lane creates its drawers with it, and the function names nothing pack-specific.
// Re-exported at the top of this file.

// ── LED ──────────────────────────────────────────────────────────────────────

// deriveArtifactLed lives in shared/card-artifact-store.js, with the `isEnabled` dimension event-pack's
// LED needs. Re-exported at the top of this file.

// ── workspace build — THE source pipeline (import + the dev loop's server) ───

// A source tree -> every artifact in it, each fully judged: assembled, validated and content-gated.
// ONE function on purpose — the same-assembler invariant says the folder a developer debugs and the
// folder they import must go through identical judgement, so the dev server and the import UI both
// call THIS and neither carries its own sequence. Errors block; warnings ride along — the caller
// decides nothing.
//
// `readMenuEngine(engineText)` → { ok, error, formatters, actions } is the ONE thing the callers supply,
// because it decides WHERE a menu engine runs to be read: the page passes the engine frame's throwaway
// Worker (logic-engine readMenuEngineExportsInWorker) — the text came from a ZIP or folder the user
// picked — and the Node dev server passes its in-process reader (tools/). Required: there is no default,
// so no caller can end up running a picked engine on the page by leaving it out.
export async function buildWorkspaceArtifacts(files, { readMenuEngine } = {}) {
    const artifacts = [];
    for (const { name, files: inner } of splitWorkspaceSources(normalizeWorkspaceRoot(files))) {
        const res = assembleArtifactSource(inner);
        const v = res.pack
            ? await judgePack(res.pack, { readMenuEngine })
            : { pack: null, errors: [], warnings: [], schemaRemovals: [], unknownSections: [], declaredFormat: '', supportedFormat: supportedFormat() };
        artifacts.push({
            name,
            pack: v.pack,                  // as judged: its schema is the allow-listed one
            errors: [...res.errors, ...v.errors],
            warnings: [...res.warnings, ...v.warnings],
            // Carried through so the workspace import toasts the unknown-section and schema-removal
            // findings the same way the paste lane does — the report alone is not enough for a piece
            // that did not install.
            schemaRemovals: v.schemaRemovals,
            unknownSections: v.unknownSections,
            declaredFormat: v.declaredFormat,
            supportedFormat: v.supportedFormat,
            orderListing: res.orderListing,
        });
    }
    return artifacts;
}

// ── release export — the pack file back from the card ────────────────────────

// PURE half of the export button: the shared artifact export (card-artifact-store buildArtifactExportFile)
// plus what only a GameLogic Pack owns — the card's "Scheme" script, the state seed and the exposes map.
export function buildPackExportFile({ registry, entries, engineText, schemaText, cardRegexes } = {}) {
    const reg = registry || {};
    if (!reg.activePackId) return { pack: null, errors: ['no pack is active on this card — nothing to export'] };
    return buildArtifactExportFile({
        artifactType: 'gamelogic', id: reg.activePackId, record: reg, entries,
        identityFix: 'Repair the pack once so they are recorded',
        engineText, cardRegexes,
        addTypeFields: (pack, errors) => {
            if (reg.schemaOwned) {
                if (typeof schemaText === 'string' && schemaText) pack.schema = schemaText;
                else errors.push('the registry records schema ownership but the "Scheme" script is empty or unreadable — export refuses rather than ship without it');
            }
            const force = (reg.force && typeof reg.force === 'object') ? reg.force : {};
            const forceFromInitVar = Array.isArray(reg.forceFromInitVar) ? reg.forceFromInitVar : [];
            if (reg.stateVersion || Object.keys(force).length || forceFromInitVar.length) {
                pack.state = {};
                if (reg.stateVersion) pack.state.version = String(reg.stateVersion);
                if (Object.keys(force).length) pack.state.force = force;
                if (forceFromInitVar.length) pack.state.forceFromInitVar = forceFromInitVar;
            }
            if (reg.exposes && typeof reg.exposes === 'object' && Object.keys(reg.exposes).length) pack.exposes = reg.exposes;
        },
    });
}

// The end every export button shares (GameLogic Pack, StatusMenu Pack, GameLogic Plugin): a built file is
// re-validated and re-gated before it is offered — an export is not gate-free — and named
// `<id>-v<version>.json`. `gateOptions` carries what the gate needs read first (a menu engine's exports).
export function finishArtifactExport(built, gateOptions) {
    if (!built.pack) return { ok: false, errors: built.errors };
    const v = validatePack(built.pack);
    const g = gateArtifactSource(built.pack, gateOptions);
    if (v.errors.length || g.errors.length) return { ok: false, errors: [...v.errors, ...g.errors] };
    const fileName = built.pack.id + '-v' + built.pack.version + '.json';
    return { ok: true, pack: built.pack, text: JSON.stringify(built.pack, null, 2), fileName, warnings: [...v.warnings, ...g.warnings] };
}
