// logic-engine/logic-engine-core.js — pure logic: no host imports, unit-testable.
// The execution contract for a card's engine bundle, and what an engine's declarations mean to the host.

// The engine-identity readers live in shared/engine-header.js (P3 second consumer — the GameLogic Pack
// validator reads the same declarations, rule 3); declaredVersionOf is re-exported for this feature's
// callers. declared*Of are the COLD channel: source read for an artifact that is not running yet. A LOADED
// engine's identity comes from getScopeDeclared (loader), never from these.
export { declaredVersionOf } from '../../shared/engine-header.js';
import { declaredNameOf, declaredVersionOf } from '../../shared/engine-header.js';

// PER-CARD defaults (PROFILE scope) — merged into profileDefaults by index.js.
//   enabled — master switch for the whole feature; false = fully dormant (the loader returns
//             immediately, nothing is evaluated, globalThis stays clean).
//
// There is no setting for WHO resolves a turn: mvu-helper is the only resolver host, and the turn runner
// has one unconditional path (turn-runner.js header). A profile's leftover `resolverHost` is a retired
// name (card-config-sections), deleted by the next re-import. Do not add a host choice back: with one
// host, RES output is never ambiguous.
export const logicEngineProfileDefaults = {
    logicEngine: {
        enabled: true,
    },
};

// This card's logicEngine block, its present-but-wrong-typed fields repaired (older profiles predate it). On a
// valid block, the template included, it writes nothing: in the lobby the profile is frozen
// (sillytavern/settings-store-core.js profileRecordFor).
export function logicEngineProfileOf(p) {
    const d = logicEngineProfileDefaults.logicEngine;
    if (!p.logicEngine || typeof p.logicEngine !== 'object') p.logicEngine = structuredClone(d);
    const le = p.logicEngine;
    if (typeof le.enabled !== 'boolean') le.enabled = d.enabled;
    return le;
}

// ── The card's EVENT CONTRACT, as the verdicts the event-pack gate asks of it ──────────────────
// The ONE reader for every event-pack site: install, the scan pass, the before-generation floor seed
// and the tab. A second implementation of one fact drifts from the engine it describes, so exactly one
// reader exists here and the sites differ only in WHICH verdicts they act on.
//
// Takes the GAME scope's `declared` record (the loader's getScopeDeclared) — the values the running
// engine EXPORTS, never a copy of them. Three states, three different fixes, so it distinguishes them:
//   declared === null             no engine is loaded on this card
//   declared.eventPack === null   an engine runs, but declares no EVENT_PACK_ADAPTER
//   a field absent or malformed   the adapter declares it, wrongly
//
// Each verdict keeps the exact STANDING its parser gave it:
//   paths   FATAL   — without triggerRoot/armedPath a merge lands where the engine never reads, and
//                     that does not error: the pack installs, the LED goes green, nothing ever fires
//   writes  WARNING — the check stands down; the engine's fire-time "WRITE REFUSED" is the backstop
//   rewards WARNING — an engine that pays nothing is a COMPLETE engine, so absent ⇒ an empty list
//   scopes  WARNING — same standing as writes
//   bodyEntry FATAL when malformed — a slot declared wrongly would put every pack's beat somewhere the
//                     card never meant; ABSENT is a real answer (the entry keeps the host's default slot)
//   format  VALUE   — '' when undeclared; the CALLER fixes the default at "1.0" and must
//                     never reach for mvu-helper's own SUPPORTED_FORMAT, which answers a different
//                     question (can mvu-helper PARSE this pack, not can this card's engine RUN it)
//
// L1 holds throughout: nothing here knows what any path, field or scope value MEANS — only its shape.
export function readEventContract(declared) {
    const contract = (declared && typeof declared === 'object') ? declared.eventPack : null;
    const refusal = !declared
        ? 'no logic engine is loaded on this card — an event pack is written for one engine and cannot run without it'
        : (contract ? '' : 'this card\'s engine declares no EVENT_PACK_ADAPTER — it cannot host event packs until it exports one');
    if (refusal) {
        const refuse = { ok: false, reason: refusal };
        return { format: '', paths: refuse, writes: refuse, rewards: refuse, scopes: refuse, bodyEntry: refuse };
    }
    return {
        format: typeof contract.format === 'string' ? contract.format : '',
        paths: declaredPaths(contract),
        writes: declaredWrites(contract),
        rewards: declaredRewards(contract),
        scopes: declaredScopes(contract),
        bodyEntry: declaredBodyEntry(contract),
    };
}

// WHERE an installed pack's worldbook entry goes in the prompt — the card's layout, never the platform's.
// mvu-helper writes the three fields onto the entry and interprets none of them: which slot reaches the
// narrator, and what it may outrank, is the card's own prompt design. The vocabulary is the host's
// (TavernHelper's LorebookEntry), the same one a pack entry's sidecar uses. Absent ⇒ { entry: null }: the
// entry keeps the host's default slot, which is what every pack got before a card could say otherwise.
const LOREBOOK_POSITIONS = ['before_character_definition', 'after_character_definition', 'before_example_messages',
    'after_example_messages', 'before_author_note', 'after_author_note', 'at_depth_as_system', 'at_depth_as_assistant',
    'at_depth_as_user'];
function declaredBodyEntry(contract) {
    const slot = contract.bodyEntry;
    if (slot === null || slot === undefined) return { ok: true, entry: null };
    const example = ' — expected { "position": "at_depth_as_system", "depth": 0, "order": 500 } or { "position": "before_character_definition", "order": 500 }';
    if (typeof slot !== 'object' || Array.isArray(slot)) {
        return { ok: false, reason: 'this card\'s engine declares `bodyEntry` as ' + JSON.stringify(slot) + example };
    }
    if (!LOREBOOK_POSITIONS.includes(slot.position)) {
        return { ok: false, reason: 'this card\'s engine declares `bodyEntry.position` as ' + JSON.stringify(slot.position) + ', which is not a worldbook position (' + LOREBOOK_POSITIONS.join(' · ') + ')' };
    }
    const atDepth = slot.position.startsWith('at_depth_');
    if (atDepth && !(Number.isInteger(slot.depth) && slot.depth >= 0)) {
        return { ok: false, reason: 'this card\'s engine declares `bodyEntry.position` "' + slot.position + '" with `depth` ' + JSON.stringify(slot.depth) + ' — an at-depth slot needs a whole number of messages from the end, 0 or more' };
    }
    if (!Number.isInteger(slot.order) || slot.order < 0) {
        return { ok: false, reason: 'this card\'s engine declares `bodyEntry.order` as ' + JSON.stringify(slot.order) + ' — expected a whole number, 0 or more' };
    }
    return { ok: true, entry: { position: slot.position, depth: atDepth ? slot.depth : null, order: slot.order } };
}

// WHERE this engine keeps event state. Both fields are required and both must be dotted: a wrong
// root does not throw, it merges rows somewhere nothing reads, so an absent one is refused rather
// than guessed at.
function declaredPaths(contract) {
    const found = {};
    for (const field of EVENT_PACK_PATH_FIELDS) {
        const value = contract[field];
        if (typeof value !== 'string' || !value) {
            return { ok: false, reason: 'this card\'s engine declares no `' + field + '` in its EVENT_PACK_ADAPTER — without it mvu-helper cannot know where the engine keeps event state, and a guessed path merges rows the engine never reads' };
        }
        if (!DOTTED_PATH.test(value)) {
            // The example is SHAPE, not a real card's path: this message ships to every genre, so
            // naming one genre's roots would tell another author to write somebody else's schema.
            return { ok: false, reason: 'this card\'s engine declares ' + field + ' as ' + JSON.stringify(value) + ', which is not a dotted path — expected a form like "YourRoot.YourField" (a root, then at least one field)' };
        }
        const prototypeKey = prototypeSegmentOf(value);
        if (prototypeKey) {
            return { ok: false, reason: 'this card\'s engine declares ' + field + ' as ' + JSON.stringify(value) + ' — "' + prototypeKey + '" is a prototype key, never a stat_data key' };
        }
        found[field] = value;
    }
    return { ok: true, ...found };
}

// WHERE a pack may write, and under which rules. mvu-helper acts on the PATHS only; every rule
// (fixed · stamp · locked · monotonic · fillOnly · add · clamp · removable · removeAtZero · capacity)
// is the engine's to apply and rides through untouched, so a builder can shape its editor from it.
function declaredWrites(contract) {
    const writes = contract.writes;
    if (!Array.isArray(writes)) {
        return { ok: false, reason: 'this card\'s engine declares no `writes` array in its EVENT_PACK_ADAPTER — which paths a pack may write cannot be pre-checked here' };
    }
    for (let i = 0; i < writes.length; i++) {
        const entry = writes[i];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.path !== 'string' || !WRITE_PATH.test(entry.path)) {
            return { ok: false, reason: 'the engine\'s `writes` entry #' + (i + 1) + ' has no dotted `path` (' + JSON.stringify(entry) + ') — every entry names where a pack may write, e.g. { "path": "YourRoot.YourCollection" }' };
        }
        const prototypeKey = prototypeSegmentOf(entry.path);
        if (prototypeKey) {
            return { ok: false, reason: 'the engine\'s `writes` entry #' + (i + 1) + ' has path ' + JSON.stringify(entry.path) + ' — "' + prototypeKey + '" is a prototype key, never a stat_data key' };
        }
    }
    return { ok: true, writes };
}

// WHAT a row may be PAID when it fires. Absence is a real and complete answer here, unlike the two
// above: a card whose events change state purely through writes pays nothing, so an undeclared list
// is an empty one. Only a list that IS declared and is malformed is refused.
//
// VALIDATES ONLY WHAT MVU-HELPER CONSUMES — `name`, `path`, `fields`. It deliberately does NOT check
// `max`, `clamp` or any other ceiling: nothing on this side reads them (unallowedRewardKinds takes
// `name`; mismatchedRewardShapes takes `name`/`path`/`keyed`/`text`), and the ENGINE applies its own
// ceilings from its own adapter at fire time. A platform asserting a shape on a consumer field it
// never uses is L2 backwards, and it fails in the worst direction: refusing the whole verdict over
// `max` switches OFF the two checks above, which never need `max` at all. A genre may declare `max`
// per FIELD for a multi-field kind ({ Money: 50000, Salary: 10000 }, mirroring a per-field `clamp`);
// a scalar test would reject it, and every event-pack install on that card would silently skip
// reward checking.
function declaredRewards(contract) {
    const rewards = contract.rewards;
    if (rewards === null || rewards === undefined) return { ok: true, rewards: [] };
    if (!Array.isArray(rewards)) {
        return { ok: false, reason: 'this card\'s engine declares `rewards` as ' + typeof rewards + ' — expected an ARRAY of { name, path, fields, max } kinds' };
    }
    for (let i = 0; i < rewards.length; i++) {
        const kind = rewards[i];
        if (!kind || typeof kind !== 'object' || Array.isArray(kind) || typeof kind.name !== 'string' || !kind.name) {
            return { ok: false, reason: 'the engine\'s `rewards` entry #' + (i + 1) + ' has no `name` (' + JSON.stringify(kind) + ') — a row asks for a reward by name, e.g. { "name": "stat", "path": "YourRoot", "fields": ["A"], "max": 5 }' };
        }
        if (typeof kind.path !== 'string' || !WRITE_PATH.test(kind.path)) {
            return { ok: false, reason: 'the engine\'s `rewards` kind "' + kind.name + '" has no dotted `path` — it names the object whose fields it pays' };
        }
        const prototypeKey = prototypeSegmentOf(kind.path);
        if (prototypeKey) {
            return { ok: false, reason: 'the engine\'s `rewards` kind "' + kind.name + '" has path ' + JSON.stringify(kind.path) + ' — "' + prototypeKey + '" is a prototype key, never a stat_data key' };
        }
        if (!Array.isArray(kind.fields) || !kind.fields.length) {
            return { ok: false, reason: 'the engine\'s `rewards` kind "' + kind.name + '" declares no `fields` — a kind that pays nothing is not a kind' };
        }
    }
    return { ok: true, rewards };
}

// WHICH scope values this engine DISTINGUISHES. mvu-helper interprets no value of it — it relays the
// engine's own list so a row naming a scope the engine never spelled surfaces at install, instead of
// as an event that quietly recurs after whatever the genre's sweep is.
function declaredScopes(contract) {
    const scopes = contract.scopes;
    if (!Array.isArray(scopes)) {
        return { ok: false, reason: 'this card\'s engine declares no `scopes` array in its EVENT_PACK_ADAPTER — a row\'s scope value cannot be checked against what the engine knows' };
    }
    for (const word of scopes) {
        if (typeof word !== 'string' || !/^\w+$/.test(word)) {
            return { ok: false, reason: 'the engine declares ' + JSON.stringify(word) + ' as a scope value — expected plain identifiers, e.g. once always' };
        }
    }
    return { ok: true, scopes };
}

// ── the shapes a declared event contract is checked against ──────────────────
// Kept where the verdicts above use them, and nowhere else. A dotted path needs a root AND at least
// one field (a bare root cannot address event state); a WRITE path may be a root alone, because a
// plain object is a legal write target. `readEventContract` is their only reader.
const DOTTED_PATH = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/;
const WRITE_PATH = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/;
// `__proto__`, `constructor` and `prototype` are all \w, so both shapes above admit them — and a
// declared root is handed to shared/object-path.js's ensurePath, where `__proto__.x` would create
// `x` on Object.prototype. Refused here so the reason names the engine's field. Kept local, not
// imported from object-path.js: this file loads in the engine Worker, whose module list is pinned.
const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'prototype'];
const prototypeSegmentOf = (path) => path.split('.').find((s) => PROTOTYPE_KEYS.includes(s)) || '';
export const EVENT_PACK_PATH_FIELDS = ['triggerRoot', 'armedPath'];

// ── the shared Worker's N-text runtime ───────────────────────────────────────
// One Worker hosts N engine texts — the game's Logic Engine, one Plugin Engine per installed
// GameLogicPlugin, the StatusMenu Engine — each evaluated into its OWN scope: a private host object per
// text, so `root.*` writes from one text are invisible to every other (no cross-scope access — coupling
// happens through DATA and PROMPTS, never calls).
//
// This factory IS the Worker's message loop, extracted pure so its decisions are reachable from a test
// instead of living in an untestable generated string (L6): per-scope isolation, per-text error
// containment (one broken plugin engine must never take the game engine down), and per-scope call
// routing. engine-worker-host.js imports it into the Worker and feeds it the real postMessage.

// The scope name the GAME engine loads under. One definition so loader, worker host and runtime
// cannot drift. Other scopes are spelled by the features that own them — `plugin:<id>` (a third
// party added to a game) and `statusmenu` (the game's own display half). This file names none of
// them and ranks none of them: a scope is a scope here.
export const GAME_ENGINE_SCOPE = 'game';

// Which API answers an engine scope: the game's own for GAME_ENGINE_SCOPE, otherwise that scope's entry in
// the table of every other hosted engine (a plugin's, the StatusMenu Engine). null when nothing answers.
export function engineScopeApi({ gameApi = null, scopeApis = null } = {}, scope) {
    const name = String(scope || '');
    if (name === GAME_ENGINE_SCOPE) return gameApi || null;
    return (scopeApis && scopeApis[name]) || null;
}

// What the loader's status becomes when the standalone worldbook cannot be read (TavernHelper answers
// null for a moment during a chat switch). A Worker that is hosting texts keeps its status: a card with
// plugins but no game engine runs as 'no-engine', and the relay plans (postRelayPlan,
// postSilentRelayPlan) run the plugins only on exactly that word. The same-bytes reload cache never
// restores a status, so a downgrade here would last the session. Only when nothing is hosted does the
// status become 'book-not-ready'.
export function statusAfterUnreadableBook(currentStatus, workerHosted) {
    return workerHosted ? currentStatus : 'book-not-ready';
}

// ── The LogicEngine tab's status ─────────────────────────────────────────────────────────────────
// What the tab shows, as the words and values logic-engine-ui.js builds its genes from: the loader's state as a pill,
// then a row naming the engine, or an empty state when there is none to name. A running engine is named by what it
// declared; any other by its stored text's declarations (the cold channel above). Fixed words come as { text }, values
// as { name }.
const ENGINE_STATE_PILLS = {
    'loaded': { text: 'Loaded', status: 'success' },
    'disabled': { text: 'Disabled', status: 'neutral' },
    'no-engine': { text: 'No engine', status: 'warning' },
    'book-not-ready': { text: 'Lorebook not ready', status: 'warning' },
    'error': { text: 'Load error', status: 'danger' },
};

// The turn runner's counters (turn-runner.js getTurnRunnerCounters), each beside its word.
const RUNNER_COUNTERS = [
    ['liveResolved', { text: 'resolved' }],
    ['liveSaved', { text: 'saved' }],
    ['fenceTripped', { text: 'fence trips' }],
    ['refire', { text: 'refires' }],
    ['foreignSkipped', { text: 'replays skipped' }],
];

function runnerLine(counters) {
    const parts = [{ text: 'Turn runner' }, { name: ':' }];
    RUNNER_COUNTERS.forEach(([field, word], index) => parts.push({ name: `${index ? ' ·' : ''} ${Number(counters[field]) || 0} ` }, word));
    return { parts };
}

//   status     the loader's state (getLogicEngineStatus)
//   declared   what the running game engine declared, { name, version }
//   exports    its export names; `error` the load error
//   installed  the card's [MVU_LogicEngine] entry as read, { found, text } — null while the lorebook cannot be read
//   counters   the turn runner's session counters, shown while the engine is enabled (`isEnabled`)
// Returns { pill, row: { title, sub } | null, empty: { icon, text } | null }.
export function engineStatusView({ status, declared = null, exports = [], error = '', installed = null, counters = {}, isEnabled = false } = {}) {
    const pill = ENGINE_STATE_PILLS[status] || ENGINE_STATE_PILLS.error;
    const installedText = installed && installed.found && String(installed.text || '').trim() ? String(installed.text) : '';
    const isRunning = status === 'loaded';
    if (!isRunning && status !== 'error' && !installedText) {
        const empty = installed === null
            ? { icon: 'fa-hourglass-half', text: "The card's lorebook is not ready yet. Reload tries again." }
            : { icon: 'fa-gears', text: 'No engine on this card. Install a GameLogic Pack, or paste one below.' };
        return { pill, row: null, empty };
    }
    const identity = (isRunning
        ? [declared && declared.name, declared && declared.version]
        : [declaredNameOf(installedText), declaredVersionOf(installedText)]).filter(Boolean).join(' ');
    const sub = [];
    if (isRunning && exports.length) sub.push({ text: 'Exports', name: exports.join(', ') });
    if (status === 'error' && error) sub.push({ text: 'Load error', name: error });
    if (installedText) sub.push({ text: 'Installed', name: `${declaredVersionOf(installedText) || '?'} · ${(installedText.length / 1024).toFixed(1)} KB` });
    if (isEnabled) sub.push(runnerLine(counters));
    return { pill, row: { title: identity ? { name: identity } : { text: 'Unnamed engine' }, sub }, empty: null };
}

// Group per-scope reload notes under the KIND word each text's own source supplied, preserving both
// first-seen kind order and note order within a kind. The loader prints the result verbatim and never
// interprets a kind.
//
// Pure because the label is a guard and guards must be provable (L6): the reload line is read as the
// answer to "what is running", and any one word the loader chose would mislabel some of its contents —
// "plugin engine" for every non-game text, or "also hosted", which frames the StatusMenu Engine as an
// adjunct rather than as the Logic Engine's display counterpart. A text with no kind gets a neutral
// bucket rather than borrowing another's word.
export function groupEngineNotesByKind(entries) {
    const byKind = new Map();
    for (const entry of entries || []) {
        const kind = String((entry && entry.kind) || '').trim() || 'also hosted';
        if (!byKind.has(kind)) byKind.set(kind, []);
        byKind.get(kind).push(String((entry && entry.note) || ''));
    }
    return byKind;
}

// ONE level of namespaced function exports — 'actions.equipItem', 'formatters.moneyDisplay' — for a
// module.exports whose top level is plain objects (the StatusMenu Engine's shape). One level
// deep on purpose: the contract names exactly two namespaces, and walking arbitrarily deep would
// enumerate data structures as an API.
export function nestedFunctionNames(api) {
    const out = [];
    for (const [key, value] of Object.entries(api || {})) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        for (const [child, fn] of Object.entries(value)) {
            if (typeof fn === 'function') out.push(key + '.' + child);
        }
    }
    return out;
}

// What an engine DECLARES about itself, read from the module it just evaluated — the authoritative
// channel, because these are the very values the running code holds. Reported per scope at load so
// nothing downstream has to recover them from the engine's text.
//
// Every field is optional and an absent one is null, which means UNKNOWN: never a match, never a
// refusal. A non-string version/name/type is DROPPED rather than coerced — `String(undefined)` would
// report the word "undefined" as an engine's identity, which reads as a real answer.
//
// `eventPack` carries the five plain-data fields the HOST reads, PICKED BY NAME — never the adapter
// object itself. EVENT_PACK_ADAPTER also holds the engine's own hooks (nowStamp, daysSince, get,
// getArmed, setArmed, warn …), and a function cannot cross the structured-clone boundary: postMessage
// throws DataCloneError, the worker never answers its bootstrap, and the whole engine fails to load,
// taking the StatusMenu down with it. So the host is handed the FACTS it consumes, never the engine's
// live object. That is the same stance the facade takes in the other direction.
const eventPackContractOf = (adapter) => {
    const picked = {
        triggerRoot: typeof adapter.triggerRoot === 'string' ? adapter.triggerRoot : null,
        armedPath: typeof adapter.armedPath === 'string' ? adapter.armedPath : null,
        writes: Array.isArray(adapter.writes) ? adapter.writes : null,
        rewards: Array.isArray(adapter.rewards) ? adapter.rewards : null,
        scopes: Array.isArray(adapter.scopes) ? adapter.scopes : null,
        // Carried as declared, whatever its shape: declaredBodyEntry judges it, so a malformed one is
        // refused by name rather than dropped here into "undeclared".
        bodyEntry: adapter.bodyEntry === undefined ? null : adapter.bodyEntry,
    };
    // Round-tripped so what crosses the boundary is PROVABLY clonable, whatever a genre put inside its
    // own arrays — the picking above only guarantees the top level.
    try { return JSON.parse(JSON.stringify(picked)); }
    catch (e) {                 // EXPECTED: a cycle or non-serialisable value in a genre's own arrays.
        void e;                 // Null is a REFUSAL the event-pack gate already handles by standing
        return null;            // down and naming the fault — never a silent half-contract, and never
    }                           // a DataCloneError that would take the engine load down with it.
};

export function declaredIdentity(api) {
    const source = api || {};
    const str = (v) => (typeof v === 'string' && v ? v : null);
    const adapter = (source.EVENT_PACK_ADAPTER && typeof source.EVENT_PACK_ADAPTER === 'object'
        && !Array.isArray(source.EVENT_PACK_ADAPTER)) ? source.EVENT_PACK_ADAPTER : null;
    const format = str(source.EVENT_PACK_FORMAT);
    const contract = adapter ? eventPackContractOf(adapter) : null;
    return {
        version: str(source.ENGINE_VERSION),
        name: str(source.ENGINE_NAME),
        type: str(source.ENGINE_TYPE),
        // Absent entirely when the engine declares neither half, so "this engine runs no event packs"
        // stays distinguishable from "it declared an empty contract".
        eventPack: (contract || format) ? { ...(contract || {}), format } : null,
    };
}

// Resolve an export name against a scope's module.exports. A flat name is one property read (the game
// engine's whole call surface is flat); a single-dotted name reaches one level into a plain-object
// export. Never deeper.
export function resolveScopeExport(api, name) {
    if (!api) return undefined;
    const parts = String(name || '').split('.');
    if (parts.length === 1) return api[parts[0]];
    if (parts.length !== 2) return undefined;
    const ns = api[parts[0]];
    return (ns && typeof ns === 'object' && !Array.isArray(ns)) ? ns[parts[1]] : undefined;
}

// The `MvuHelper` facade an engine text sees inside the Worker. PLAIN DATA, rebuilt per call: the
// engine is GIVEN the facts and never handed an object to walk, and a text that mutates what it got
// cannot poison the next call or another scope's read.
//
// The copy is by hand because the shape is four tokens and a flat string map, so a hand copy is
// complete; if a nested value is ever added, this function is where it must be handled
// (`structuredClone` is on the Worker's allowlist and would do).
//
// Absent facts read as null / {} rather than a missing key, so an engine can branch on the VALUE
// without first asking whether the key exists. `{}` for exposes is the honest answer on a card that
// hosts no GameLogic Engine at all (a standalone-plugin card) — nothing is exposed.
export function buildEngineInfoFacade(engine) {
    const e = engine || {};
    const exposes = {};
    if (e.exposes && typeof e.exposes === 'object') {
        for (const key of Object.keys(e.exposes)) exposes[key] = e.exposes[key];
    }
    const facts = () => ({
        name: e.name || null,
        type: e.type || null,
        version: e.version || null,
        packId: e.packId || null,
        exposes: { ...exposes },
    });
    return Object.freeze({ engineInfo: facts });
}

// Coerce one log argument to something structured-clone-safe for the postMessage hop. Primitives ride
// as-is (so numbers stay numbers in the console); an object is JSON-serialised for readability, falling
// back to String() for the circular/unserialisable case — legible object shape instead of "[object Object]".
function stringifyLogArg(a) {
    if (a === null || a === undefined) return a;
    const t = typeof a;
    if (t === 'string' || t === 'number' || t === 'boolean') return a;
    // An Error serialises to "{}" — its message and stack are not own enumerable properties — so an
    // engine's `log.warn('…failed:', e)` would arrive saying nothing. Its stack leads with the message.
    if (a instanceof Error) return String(a.stack || a.message || a);
    try { return JSON.stringify(a); } catch (_e) { return String(a); }   // EXPECTED: circular/unserialisable → String
}

const VERBOSITY_LEVELS = { off: 0, lifecycle: 1, verbose: 2, trace: 3 };

// `MvuHelper.log` — the community logging contract (mirrors sillytavern/log.js). The methods POST to the
// page, where the real log.js applies LIVE gating against extension_settings — so a toggle flipped
// mid-turn takes effect with no snapshot staleness. enabled()/domainEnabled() answer synchronously from
// the sampled gate so an author can guard an expensive preview before building it; a hair of staleness
// there only wastes one preview, never mis-gates output. Runs inside the Worker: synchronous, no await.
// The page prints each line as `[mvu-helper] [engine:<scope>] [<tag>]… message`; child('RES') adds a tag.
export function buildEngineLog(post, scope, gate, tags = []) {
    const g = gate || {};
    const verbosity = typeof g.verbosity === 'number' ? g.verbosity : (VERBOSITY_LEVELS[g.verbosity] || 0);
    const domains = (g.domains && typeof g.domains === 'object') ? g.domains : {};
    const emit = (method, extra, args) => {
        // A logger must never throw into the engine — post can only fail if the arg map does, and that is
        // already caught per-arg. Belt-and-suspenders around the hop itself.
        try { post(Object.assign({ t: 'log', method, scope, tags: tags.slice(), args: args.map(stringifyLogArg) }, extra)); }
        catch (_e) { /* EXPECTED: a logger cannot log its own transport failure */ }
    };
    return Object.freeze({
        error: (...a) => emit('error', null, a),
        warn: (...a) => emit('warn', null, a),
        lifecycle: (...a) => emit('lifecycle', null, a),
        verbose: (...a) => emit('verbose', null, a),
        trace: (...a) => emit('trace', null, a),
        domain: (name, level, ...a) => emit('domain', { domain: String(name || 'pipeline'), level: String(level || 'lifecycle') }, a),
        enabled: (level) => verbosity >= (VERBOSITY_LEVELS[level] == null ? Infinity : VERBOSITY_LEVELS[level]),
        domainEnabled: (name) => domains[name] === true,
        child: (tag) => buildEngineLog(post, scope, gate, [...tags, String(tag)]),
    });
}

// `MvuHelper.messages` — content-free message navigation over the snapshot projection, in place of the
// raw getContext().chat array: the engine asks a question and gets an answer, never an object to walk.
// Roles are SillyTavern's own (system/user/assistant), mapped from the message flags exactly as ST
// derives them: is_user → 'user', is_system → 'system', else → 'assistant'. Indices match the real chat
// (null entries stay null); a negative index counts from the end. NO text, NO author name.
export function buildMessagesNavigator(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const roleAt = (i) => { const m = list[i]; return m ? (m.isUser ? 'user' : (m.isSystem ? 'system' : 'assistant')) : null; };
    const viewAt = (i) => { const m = list[i]; return m ? { index: i, role: roleAt(i), swipeId: (m.swipeId == null ? 0 : m.swipeId) } : null; };
    const matches = (i, role) => list[i] != null && (!role || roleAt(i) === role);
    const resolveFrom = (from, direction) => {
        if (typeof from === 'number') return from < 0 ? list.length + from : from;
        return direction === 'forward' ? 0 : list.length - 1;
    };
    return Object.freeze({
        count: (role) => { let c = 0; for (let i = 0; i < list.length; i++) if (matches(i, role)) c++; return c; },
        at: (index) => viewAt(typeof index === 'number' && index < 0 ? list.length + index : index),
        latest: (role) => { for (let i = list.length - 1; i >= 0; i--) if (matches(i, role)) return viewAt(i); return null; },
        find: (opts) => {
            const o = opts || {};
            const direction = o.direction === 'forward' ? 'forward' : 'backward';
            const skip = (typeof o.skip === 'number' && o.skip > 0) ? Math.floor(o.skip) : 0;
            const from = resolveFrom(o.from, direction);
            let skipped = 0;
            if (direction === 'forward') {
                for (let i = Math.max(0, from); i < list.length; i++) if (matches(i, o.role)) { if (skipped++ < skip) continue; return viewAt(i); }
            } else {
                for (let i = Math.min(list.length - 1, from); i >= 0; i--) if (matches(i, o.role)) { if (skipped++ < skip) continue; return viewAt(i); }
            }
            return null;
        },
    });
}

// `MvuHelper.settings` in the Worker — the same names as the page's (shared/public-settings-core.js), read
// from the values the page sampled for this call. An engine reads; `set` answers false and says why, since
// nothing in the Worker writes to the page. An unknown name answers undefined and warns once per call.
export function buildEngineSettings(values, log) {
    const sampled = (values && typeof values === 'object') ? values : {};
    const warnedNames = new Set();
    return Object.freeze({
        get: (name) => {
            const key = String(name);
            if (Object.prototype.hasOwnProperty.call(sampled, key)) return sampled[key];
            if (!warnedNames.has(key)) {
                warnedNames.add(key);
                log.warn('the engine asked for "' + key + '", which is not a setting — the settings are ' + Object.keys(sampled).join(', '));
            }
            return undefined;
        },
        set: (name) => {
            log.warn('the engine tried to set "' + String(name) + '" — an engine reads settings and sets none; a card\'s page script can set a debug switch');
            return false;
        },
        names: () => Object.keys(sampled),
    });
}

// The whole `MvuHelper` facade an engine text sees inside the Worker: identity (engineInfo), logging
// (log), message navigation (messages) and the settings it may read (settings). Rebuilt per call so a
// text that mutates what it got cannot poison the next call or another scope's read.
export function buildMvuHelperFacade({ engine, snapshot, scope, post } = {}) {
    const info = buildEngineInfoFacade(engine);
    const snap = snapshot || {};
    const log = buildEngineLog(post, scope, snap.logGate);
    return Object.freeze({
        engineInfo: info.engineInfo,
        log,
        messages: buildMessagesNavigator(snap.messages),
        settings: buildEngineSettings(snap.settings, log),
    });
}

// Imported by the engine Worker's bootstrap, which loads this file by URL (engine-worker-host.js workerSource).
/** @public */
export function createEngineWorkerRuntime({ post, execute, buildHost, getBlockReport } = {}) {
    const hosts = {};   // scope → the private object that text's root.*/window.* writes land on
    const apis = {};    // scope → that text's module.exports

    // A text's host starts EMPTY: its `root.*` writes land here and nowhere else. mvu-helper offers an
    // engine exactly one way to log through it — `MvuHelper.log` on the facade below — and plants no
    // functions of its own on the host: a name planted on every scope would be one engine's word that
    // no other engine knows.
    const makeHost = () => ({});

    // SNAPSHOT FACADE — the caller sends the sampled host data with each message; every scope's host gets
    // the same rebuilt facade (read-only data, nothing to isolate). `MvuHelper` carries identity
    // (engineInfo — the engine this card hosts), logging (log — the community contract) and message
    // navigation (messages). `SillyTavern` is the empty shell buildHost returns. Each scope's log is
    // tagged with its own scope so the page can tell plugin lines from the game's.
    const installFacade = (snapshot, engine) => {
        for (const scope of Object.keys(hosts)) {
            hosts[scope].SillyTavern = buildHost(snapshot);
            hosts[scope].MvuHelper = buildMvuHelperFacade({ engine, snapshot, scope, post });
        }
    };

    return {
        handle(msg) {
            if (msg.t === 'load') {
                const texts = Array.isArray(msg.texts) ? msg.texts : [];
                // Hosts FIRST, facade second, execution third — a text may read host.SillyTavern at
                // eval time (globalLogic's browser branch does), so the facade must be in place
                // before any code runs.
                for (const text of texts) hosts[String(text.scope || '')] = makeHost();
                installFacade(msg.host, msg.engine);
                const scopes = {};
                for (const text of texts) {
                    const scope = String(text.scope || '');
                    // Per-text containment: a plugin engine that throws at eval reports an error for
                    // ITS scope and every other text still loads. The CALLER decides which scope's
                    // error is fatal (the game's is; a plugin's is not).
                    try {
                        apis[scope] = execute(String(text.code || ''), hosts[scope]);
                        scopes[scope] = {
                            exports: Object.keys(apis[scope]).filter((k) => typeof apis[scope][k] === 'function'),
                            // ONE level of namespaced exports ('actions.equipItem', 'formatters.moneyDisplay')
                            // — the StatusMenu Engine's shape, whose top level is two plain objects and
                            // would otherwise enumerate as nothing callable. Reported SEPARATELY from
                            // `exports`, so the consumers of the flat list (the loader's game branch, the
                            // plugin proxies, the reload log) never see a dotted name in it.
                            nestedExports: nestedFunctionNames(apis[scope]),
                            // What this engine says about ITSELF (version/name/type) and, for a game
                            // engine, its event-pack contract. Reported beside the export lists so the
                            // host never parses engine text to recover them.
                            declared: declaredIdentity(apis[scope]),
                            error: '',
                        };
                    } catch (e) {
                        scopes[scope] = { exports: [], nestedExports: [], declared: null, error: String((e && e.message) || e) };
                    }
                }
                post({ t: 'loaded', scopes, report: getBlockReport ? getBlockReport() : {} });
                return;
            }
            if (msg.t === 'call') {
                installFacade(msg.host, msg.engine);
                const api = apis[String(msg.scope || '')];
                const fn = resolveScopeExport(api, msg.name);
                if (typeof fn !== 'function') {
                    post({ t: 'error', id: msg.id, message: 'the engine scope "' + String(msg.scope || '') + '" exports no function named "' + msg.name + '"' });
                    return;
                }
                // Promise-wrapped so a THROW and a REJECTION land on the same path (see the worker
                // host header for why an async export must not resolve to a pending Promise).
                Promise.resolve()
                    .then(() => fn(...(msg.args || [])))
                    .then((value) => post({ t: 'result', id: msg.id, value }))
                    .catch((e) => post({ t: 'error', id: msg.id, message: String((e && e.message) || e), stack: String((e && e.stack) || '') }));
            }
            if (msg.t === 'callBatch') {
                // The formatter pre-pass: MANY calls, ONE round trip — Worker RPC is async and menu
                // rendering is synchronous, so the renderer collects every request first and this
                // answers them all in one message. Per-call containment, because one missing or
                // throwing formatter must cost ITS cell only: `missing` and `error` are marked in the
                // entry, never thrown — the whole batch always resolves.
                installFacade(msg.host, msg.engine);
                const api = apis[String(msg.scope || '')];
                const calls = Array.isArray(msg.calls) ? msg.calls : [];
                Promise.all(calls.map((c) => {
                    const fn = resolveScopeExport(api, c && c.name);
                    if (typeof fn !== 'function') return Promise.resolve({ ok: false, missing: true });
                    return Promise.resolve()
                        .then(() => fn(...((c && c.args) || [])))
                        .then((value) => ({ ok: true, value }))
                        .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
                })).then((values) => post({ t: 'result', id: msg.id, value: values }));
            }
        },
    };
}

// Evaluate an engine bundle against a caller-supplied host object. Throws on a compile/run
// error — the caller surfaces it (never a silent half-loaded engine).
//
// THE CONTRACT (the wire_resolver bundle shape, run here unchanged): the bundle is one self-contained
// dual-mode JS blob — preludes (i18n.cjs → root.__I18N_API__, eventpack.cjs → root.__EVENTPACK__)
// followed by the genre's globalLogic IIFE, each closing over `typeof window/globalThis !== 'undefined'`.
// We run it via new Function with `module`, `exports`, `window`, AND `globalThis` shadowed:
//   • `module.exports` catches the Node-branch exports — the LAST assignment wins, which is the
//     genre engine itself (preludes assign earlier, globalLogic overwrites). That object IS the
//     public API (School v4: resolveTurn · i18nLabel · sweepCandidateLines · initiativeMenu).
//   • `window`/`globalThis` both point at the caller's PRIVATE host object, so root.* exposures
//     land there instead of polluting the real page globals.
//
// ⚠ THIS IS NOT THE SECURITY BOUNDARY, and the shadowing above must not be read as one. Parameter
// shadowing hides four NAMES; it does nothing about `Function('return this')()`, which reaches the
// real global without ever using them.
// The boundary is the CAPABILITY BLOCK, and it lives in the caller — the only production caller is
// the engine Worker bootstrap (engine-worker-host.js), which raises the block for good before any
// text runs. Kept out of here on purpose so this half stays pure and unit-testable (the drift guards
// call it directly, unblocked, in Node). If you add a second production caller, it raises the block too.
/** @public */
export function executeEngineText(code, host) {
    const module_ = { exports: {} };
    new Function('module', 'exports', 'window', 'globalThis', code)(module_, module_.exports, host, host);
    const api = (module_.exports && typeof module_.exports === 'object') ? module_.exports : {};
    return api;
}

// ── the dice deal (rollPool) ─────────────────────────────────────────────────
// The extension deals the dice so the extension KNOWS the numbers: the deal is cached per
// generation (stable across prompt re-renders, fresh on regen/swipe) and kept as a receipt the
// turn runner hands to resolveTurn, so RES can verify the die a check claims instead of trusting
// the narrator's self-report — a pool born and dying inside one EJS scope leaves nothing to audit.
//
// How many FACES a die has is the caller's choice (`sides`, default 20), never the dealer's: a genre
// on 2d6 or d100 needs a die its resolver can verify, and no mapping from a fixed die gives one — 20
// does not divide by 6, so any d20 → d6 map makes two faces come up 20% of the time instead of 16.7%.

// One pool holds at most POOL_DICE_MAX dice — a turn needing more takes a second pool name. Every
// bound here is a sanity limit, not a mechanic: it keeps a typo from reading as a real ask.
export const POOL_DICE_MAX = 20;
export const DIE_SIDES_DEFAULT = 20;
export const DIE_SIDES_MIN = 2;
export const DIE_SIDES_MAX = 1000;

// The no-hash roller: reject-sample the top of the 32-bit range so every face is equally likely for
// ANY face count. Math.random only when crypto is absent from the scope.
export function cryptoDicePool(count, sides = DIE_SIDES_DEFAULT) {
    const cg = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
    const limit = Math.floor(0x100000000 / sides) * sides;   // the largest multiple of `sides` within 2^32
    const roll = () => {
        if (cg) { const b = new Uint32Array(1); let x; do { cg.getRandomValues(b); x = b[0]; } while (x >= limit); return (x % sides) + 1; }
        return Math.floor(Math.random() * sides) + 1;
    };
    return Array.from({ length: count }, roll);
}

// The hash path: same (count, hash, sides) → the same pool, forever — the swipe-stable dice an RPG
// boss fight seeds from something stable across swipes ({chatId, mid, hash(user line)}).
// Crypto cannot be seeded, so this path is FNV-1a 32-bit → mulberry32; the generator swap is the
// deliberate price of determinism, chosen per-call. (FNV-1a also exists in shared/string-hash.js
// hash36 — different output domain, and this file imports nothing by design.)
// A seeded d20's sequence must never change — a saved boss fight's dice depend on it — and the suite
// pins it with a golden vector.
export function seededDicePool(count, hash, sides = DIE_SIDES_DEFAULT) {
    let h = 0x811c9dc5;
    const s = String(hash);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    let a = h >>> 0;
    const rng = () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return Array.from({ length: count }, () => Math.floor(rng() * sides) + 1);
}

// Generation types that are NOT a new turn of the story. ONE definition for both consumers — the
// dealer must not re-deal on them (noteGenerationStarted says what each one is and what breaks),
// and the PRE interceptor must not run its pass on them — so the same reply keeps the same dice
// AND the same PRE verdict, never one without the other.
const NON_TURN_GENERATION_TYPES = new Set(['continue', 'quiet', 'impersonate']);

// ST's Generate() `type`: undefined / '' / 'normal' for a fresh turn, 'regenerate', 'swipe',
// 'continue', 'quiet', 'impersonate'. Only the three above are not a turn of the story.
export function isStoryTurnGenerationType(type) {
    return !NON_TURN_GENERATION_TYPES.has(type);
}

const describeArgument = (value) => (typeof value === 'string' ? JSON.stringify(value) : String(value));

// What is wrong with a deal request, or '' when nothing is. Named per argument, because "rollPool
// dealt nothing" with no cause sends the reader to the wrong line of their template. Nothing is
// coerced or defaulted past this point (no-fallback rule): a bad ask deals NOTHING — an empty pool
// the template shows at once, never a plausible pool of a size nobody asked for.
export function diceRequestProblem(count, sides) {
    if (!Number.isInteger(count) || count < 1 || count > POOL_DICE_MAX) {
        return `count must be a whole number from 1 to ${POOL_DICE_MAX} (got ${describeArgument(count)}) — a turn needing more dice takes a second pool name`;
    }
    if (!Number.isInteger(sides) || sides < DIE_SIDES_MIN || sides > DIE_SIDES_MAX) {
        return `sides must be a whole number from ${DIE_SIDES_MIN} to ${DIE_SIDES_MAX} (got ${describeArgument(sides)})`;
    }
    return '';
}

// A caller that names no pool gets this one. Named pools exist so INDEPENDENT consumers (e.g. a
// PRE call vs the narrator window) each hold their OWN dice — same epoch, zero slot collisions by
// construction. Convention (card-side, not enforced here): a call passes its own call name.
const UNNAMED_POOL = 'default';

// A pool is a NAME and a FACE COUNT: `MOVE` in d6 and `MOVE` in d20 are two pools and never share a
// slot. JSON keeps the pair unambiguous whatever characters a name holds.
const poolKey = (name, sides) => JSON.stringify([name, sides]);

// The dealer: epoch-keyed cache + receipt. Pure factory so the semantics are table-testable with
// injected deterministic rollers; roll-pool.js instantiates ONE, wires GENERATION_STARTED, and
// gives `onRefused` its voice. A refused ask is reported once per generation per reason: a template
// re-renders several times per turn and must not print the same line each time.
export function createRollPoolDealer({ rollFresh = cryptoDicePool, rollSeeded = seededDicePool, onRefused = null } = {}) {
    let epoch = 0;      // bumped per real generation
    let dealt = null;   // { epoch, pools: { <poolKey>: { pool, sides, dice } }, seeded: { <poolKey>: { hash, sides, dice } } } — only the CURRENT epoch's deal is valid
    let refusedThisEpoch = new Set();
    const currentDeal = () => {
        if (!dealt || dealt.epoch !== epoch) dealt = { epoch, pools: {}, seeded: {} };
        return dealt;
    };
    const refuse = (reason) => {
        if (onRefused && !refusedThisEpoch.has(reason)) {
            refusedThisEpoch.add(reason);
            onRefused(reason);
        }
        return [];
    };
    return {
        // Returns true when the epoch advanced. A new deal is owed ONLY by a generation that is a
        // new TURN of the story — everything else must keep seeing the last real deal.
        //   • dry run     — assembles a prompt without generating; must never burn a deal.
        //   • continue    — extends the SAME reply, whose prose already consumed dice from this
        //                   pool; a re-deal would re-roll the narrator's remaining dice mid-reply
        //                   AND make the receipt falsely accuse the checks it already wrote.
        //   • quiet       — an ST-INTERNAL generation (the Summarize extension fires one right
        //                   after a message; /gen is another). It is NOT dry-run: GENERATION_STARTED
        //                   carries dryRun=false and interceptors run, so without this guard a
        //                   background summary landing between the narrate prompt build and RES
        //                   replaces the receipt — and RES then compares the narrator's declared
        //                   die against a pool it never saw, emitting a FALSE "CHECK DIE NOT FROM
        //                   POOL". Verify-only, so no state damage — but a lying console line, which
        //                   is the exact failure the receipt exists to prevent.
        //   • impersonate — writes the USER's line, not a reply; no narrator consumes a die.
        noteGenerationStarted(type, isDryRun) {
            if (isDryRun) return false;
            if (!isStoryTurnGenerationType(type)) return false;
            epoch += 1;
            refusedThisEpoch = new Set();
            return true;
        },
        rollPool(count, hash, poolName, sides) {
            const faces = (sides === undefined || sides === null) ? DIE_SIDES_DEFAULT : sides;
            const problem = diceRequestProblem(count, faces);
            if (problem) return refuse(`rollPool dealt nothing — ${problem}`);
            const deal = currentDeal();
            if (hash !== undefined && hash !== null && hash !== '') {
                // Seeded dice ENTER the receipt: an RPG boss fight's
                // swipe-stable dice must be verifiable by a resolver like any other deal. The pool
                // CACHE stays bypassed — determinism comes from the roller itself (same (count, hash,
                // sides) → same dice, always), so recording changes what the receipt CONTAINS, never
                // what the dice ARE. Kept in a map of its own, so a fresh pool whose name collides with
                // a hash string can never be clobbered; growth keeps the longest deal (a shorter
                // re-ask is a prefix of it — seededDicePool re-derives one sequence).
                const dice = rollSeeded(count, hash, faces);
                const key = poolKey(String(hash), faces);
                const known = deal.seeded[key];
                if (!known || known.dice.length < dice.length) deal.seeded[key] = { hash: String(hash), sides: faces, dice: dice.slice() };
                return dice;
            }
            const name = (typeof poolName === 'string' && poolName.trim()) ? poolName.trim() : UNNAMED_POOL;
            const key = poolKey(name, faces);
            let entry = deal.pools[key];
            if (!entry) entry = deal.pools[key] = { pool: name, sides: faces, dice: rollFresh(count, faces) };
            else if (entry.dice.length < count) entry.dice = entry.dice.concat(rollFresh(count - entry.dice.length, faces));
            // Growth appends, shrink slices — a pool's PREFIX never changes within an epoch, so ① is ①
            // no matter how many times or at what count the prompt re-renders.
            return entry.dice.slice(0, count);
        },
        // The receipt for the turn runner: the UNION of every pool dealt this generation — fresh
        // AND seeded — or null when nothing was dealt this epoch (no template asked the dealer; one
        // that rolled inline leaves genuinely nothing to verify against).
        // Union because the receipt check is membership-only for a card that deals one die size.
        currentDealtPool() {
            if (!dealt || dealt.epoch !== epoch) return null;
            const all = [...Object.values(dealt.pools), ...Object.values(dealt.seeded)].flatMap((entry) => entry.dice);
            return all.length ? all : null;
        },
        // The same receipt with each pool's identity kept: { pool, sides, dice } for a named or
        // default pool, { hash, sides, dice } for a seeded deal. A resolver that deals more than one
        // die size checks a claim against the pool it came from — in the flat union a d6 "4" passes
        // on a d20's 4. null when nothing was dealt this generation, exactly like currentDealtPool.
        currentDealtPools() {
            if (!dealt || dealt.epoch !== epoch) return null;
            const pools = [
                ...Object.values(dealt.pools).map((entry) => ({ pool: entry.pool, sides: entry.sides, dice: entry.dice.slice() })),
                ...Object.values(dealt.seeded).map((entry) => ({ hash: entry.hash, sides: entry.sides, dice: entry.dice.slice() })),
            ];
            return pools.length ? pools : null;
        },
    };
}
