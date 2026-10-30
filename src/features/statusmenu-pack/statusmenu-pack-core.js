// statusmenu-pack/statusmenu-pack-core.js — PURE decisions for the StatusMenu Pack lane (G3):
// registry shape, the entry plan, the activation decision, the formatter cross-check, the batch-RPC
// request plan, and the patch-shape guard. No host imports — every decision here is unit-testable,
// and the lorebook/regex I/O those decisions dictate lives in statusmenu-pack-activation.js (L6).
//
// The FILE format is not defined here: a StatusMenu Pack file goes through the shared §3 validator
// (gamelogic-pack-core.js, packType "statusmenu") on its way into the library, exactly like the other
// two pack types. This module begins where that validator ends — with a pack object already known to
// be well-formed.

import {
    libraryEntryComment,
    parseRegistryJson, buildRegistryText,
} from '../../shared/card-artifact-store.js';
import { deriveArtifactLed, artifactIdentityRecord, buildArtifactExportFile } from '../../shared/card-artifact-store.js';
import { compareVersions } from '../../shared/version-compare.js';
import { declaredVersionOf } from '../../shared/engine-header.js';
import { isPrototypeKey } from '../../shared/object-path.js';
// Pure despite living beside the host wrappers (same L6 stance the pack lane's import records): the
// shared lobby/loading/unstarted ORDERING, and the shared unreadable SENTENCE.
import { cardAccessProblem, cardUnreadableReason } from '../../sillytavern/card-access-core.js';
import { MENU_PLACEHOLDER } from '../../sillytavern/mvu-bridge-core.js';
// The lift boundary (plans/executed/statusmenu-containment.md M1/M2): the region wrapper, its inverse, and
// TavernHelper's own render predicate — pure, and the published region contract's.
import { wrapRenderedRegion, unwrapRenderedRegion, detectRegionName, isTavernHelperFrontendText, TAVERNHELPER_FRONTEND_TOKENS } from '../../shared/rendered-region.js';
import { installReachTexts } from '../../shared/pack-install-warning-core.js';

export const STATUSMENU_TYPE = 'statusmenu';

// ── registry (§5 pattern, one active record) ─────────────────────────────────

// '[StatusMenuPack:Registry]' — its OWN entry beside the pack and plugin registries (§2: three
// separate entries, one per artifact lifecycle). Separation is load-bearing: uninstalling the game
// must not wipe the menu's bookkeeping (V17), and the reverse.
export function menuRegistryComment() {
    return libraryEntryComment(STATUSMENU_TYPE, 'Registry');
}
export function menuRegistryMatch() {
    return menuRegistryComment().toLowerCase();
}

// Parse the registry entry's content. THROWS on malformed JSON — a broken registry read as "no menu
// active" would make the next uninstall sweep destructive off a typo (same stance as the pack and
// plugin registries; callers catch, report, and stand down).
export function parseMenuRegistry(raw) {
    // 'null' for an empty body: this registry holds ONE active record, like the pack's — "no menu
    // active" — not the plugin lane's array or event-pack's map.
    const obj = parseRegistryJson(raw, { whenEmpty: 'null' });
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('the StatusMenu registry must be a JSON object');
    if (typeof obj.activeMenuId !== 'string' || !obj.activeMenuId) throw new Error('the StatusMenu registry has no "activeMenuId"');
    return {
        activeMenuId: obj.activeMenuId,
        ver: String(obj.ver == null ? '0' : obj.ver),
        installedComments: Array.isArray(obj.installedComments) ? obj.installedComments.map(String) : [],
        // The engine text lives under [MVU_StatusMenuEngine] — one named thing, not prefix-swept, so
        // ownership is a flag exactly like the game pack's engineOwned: uninstall clears the entry
        // only when this install wrote it, and a dev-lane upload the user made is never deleted as
        // if it were ours.
        engineOwned: obj.engineOwned === true,
        // What the install wrote there, as its slotFingerprint (menuOwnedSlots). Absent reads as '', which matches no text.
        engineFingerprint: String(obj.engineFingerprint || ''),
        installedRegexNames: Array.isArray(obj.installedRegexNames) ? obj.installedRegexNames.map(String) : [],
        // G4: did THIS install write the pack-host shell? Same flag discipline as engineOwned —
        // uninstall removes the shell only when it is ours; absent (older registries) reads false.
        shellOwned: obj.shellOwned === true,
        // M2: the rows THIS install lifted into [MVU_StatusMenuBody:<row>] entries, by script_name.
        // Same discipline as engineOwned — uninstall clears exactly these; absent reads as none.
        liftedRows: Array.isArray(obj.liftedRows) ? obj.liftedRows.map(String) : [],
        // W7 — identity carried through the parse (workflow plan §8.2); empty strings on a registry
        // written before W7. `targetsPackId` rides here too when the pack declared one.
        ...artifactIdentityRecord(obj),
        ...(Array.isArray(obj.regexOrder) ? { regexOrder: obj.regexOrder.map(String) } : {}),
        installedAt: String(obj.installedAt || ''),
    };
}

export function buildMenuRegistryContent(registry) {
    return buildRegistryText(menuRegistryComment(), 'StatusMenu Packs', registry);
}

// ── the installed entries (§10) ──────────────────────────────────────────────

// The layout entry's comment: '[StatusMenuPack:<id>] (Layout)'.
//
// ▲ THE ONE ENTRY COMMENT THAT IS A PUBLISHED CROSS-REPO CONTRACT, AND THE ONLY REASON IT IS NOT A
// SECTION ENTRY like the plugin engine and both panels (sectionEntryComment). mvu-helper WRITES this
// entry; the thing that READS it is MvuStatMenuBuilder's runtime shell, which lives on the card
// inside the `StatusMenu` regex's replace_string and builds the needle by concatenation:
//
//     '[StatusMenuPack:' + packId + '] (Layout)'
//
// So the spelling is frozen by every menu shell already shipped, not by this repo. Renaming it here
// made the shell report `packs found=1 rendered=0 skipped=1 — the pack layout entry is missing or
// empty` and the menu drew an empty frame (live, ArtificKoi, 2026-09-04). Changing it is a migration
// of a public contract: it needs a builder release AND a re-export of every menu, so it is the user's
// call, never a tidiness pass.
//
// ▲ A GREP FOR THE MARKER TEXT CANNOT FIND THAT READER — it concatenates, and it is a build product
// inside a regex on the card rather than a file in any repo. The question that finds it is "who READS
// this comment", never "who spells it".
//
// Reservation is unaffected: the comment carries `[StatusMenuPack:`, which rule 4 refuses anywhere in
// an author's entry, and the uninstall sweep bounds on `]` OR `:` so it matches this shape too.
export function menuLayoutComment(id) {
    return libraryEntryComment(STATUSMENU_TYPE, id) + ' (Layout)';
}

// What activation writes for a validated pack: the layout entry (the pack's declarative half,
// re-serialized pretty so a human can inspect the installed copy), plus any generic prompt entries the
// file carries, each prefixed for the sweep exactly as the plugin lane prefixes its own.
// Everything is a silent data carrier unless the pack's own entry says otherwise — the layout is
// consumed by the renderer (builder phase B2), never injected into a prompt.
export function planMenuEntries(pack) {
    const entries = [];
    const installedComments = [];
    if (pack && pack.layout !== undefined) {
        const comment = menuLayoutComment(pack.id);
        entries.push({
            comment,
            content: JSON.stringify(pack.layout, null, 2),
            enabled: false, type: 'constant', key: [], keys: [],
        });
        installedComments.push(comment);
    }
    const prefix = libraryEntryComment(STATUSMENU_TYPE, pack && pack.id) + ' ';
    for (const entry of (Array.isArray(pack && pack.entries) ? pack.entries : [])) {
        const { uid: _uid, ...fields } = entry;
        const comment = prefix + String(entry.comment || '');
        entries.push({ ...fields, comment });
        installedComments.push(comment);
    }
    return { entries, installedComments };
}

// ── the activation decision (§6 shape) ───────────────────────────────────────

// PURE: every input is a plain value the host glue reads first. Ordered like the pack's — total
// refusals first, then the version verdict. `regexApiUp` is asked only when the file ships regexes:
// the two host APIs attach independently, and a menu pack IS mostly regexes.
export function decideMenuActivation({ isCardOpen, isChatStarted, areEntriesReadable, bookBinding, bookName, pack, registry, regexApiUp = true } = {}) {
    const reasons = [];
    // The ordering is cardAccessProblem's, not this lane's. It used to re-derive it here as
    // `!isCardOpen || !isChatStarted` FIRST, which put the message count ahead of the book and told a
    // user on a fresh card with an unreadable book to open a chat — the exact conflation
    // card-access-core's header records. The sentence is shared too (cardUnreadableReason).
    const access = cardAccessProblem({ isCardOpen, isChatStarted, areEntriesReadable });
    if (access === 'card-unreadable') {
        return { action: 'card-unreadable', reasons: [cardUnreadableReason({ binding: bookBinding, bookName })] };
    }
    if (access === 'no-chat') {
        return { action: 'no-chat', reasons: ['open a chat first — installing a menu writes that card\'s worldbook'] };
    }
    if (!pack || pack.packType !== STATUSMENU_TYPE) {
        return { action: 'invalid', reasons: ['not a StatusMenu Pack file (packType "' + String(pack && pack.packType) + '")'] };
    }
    if (Array.isArray(pack.regex) && pack.regex.length && !regexApiUp) {
        return { action: 'regex-api-down', reasons: ['this menu ships ' + pack.regex.length + ' regex(es) and the TavernHelper regex API has not attached yet — retry in a moment (installing without them would leave the menu invisible)'] };
    }
    if (!registry || !registry.activeMenuId) return { action: 'install', reasons };
    if (registry.activeMenuId !== pack.id) {
        // ONE menu per card: a second placeholder claimant is the silent first-wins death Track B
        // §B.1 measured, so a different id replaces the active one and says so. `activeMenuId` is for the
        // question that asks.
        return { action: 'switch', activeMenuId: registry.activeMenuId, reasons: ['replaces the active menu "' + registry.activeMenuId + '" — a card renders ONE menu'] };
    }
    const cmp = compareVersions(String(pack.version || '0'), registry.ver);
    if (cmp > 0) return { action: 'upgrade', reasons };
    if (cmp < 0) {
        return {
            action: 'downgrade', installedVersion: registry.ver, libraryVersion: String(pack.version || '?'),
            reasons: ['the library copy is v' + (pack.version || '?') + ' but v' + registry.ver + ' is installed — confirm the downgrade'],
        };
    }
    return { action: 'reinstall', reasons };
}

// ── formatter surfaces (§9.5/§10a) ───────────────────────────────────────────

// Walk a layout for its cells. A "cell" is any object carrying a `formatters` map or an `action`
// name — the walk is shape-blind beyond that (L1: the platform does not know what a TabConfig is,
// only which fields are its own contract), so builder-side layout growth never needs a change here.
function walkLayout(layout, visit) {
    const walk = (node, path) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach((v, i) => walk(v, path + '[' + i + ']')); return; }
        visit(node, path);
        for (const key of Object.keys(node)) walk(node[key], path ? path + '.' + key : key);
    };
    walk(layout, '');
}

// Every formatter NAME a layout references, deduped and sorted — the cross-check half the dev lane
// runs on every load (§9.3: uploading one half alone can leave the layout naming an export that no
// longer exists).
// Does what this activation wrote change what a rendered menu SHOWS? A StatusMenu frame reads its
// layout from the lorebook once, at its own init, and asks the Worker for formatter values at render
// time — so a new layout or new engine text is invisible in every frame already on screen, exactly like
// a changed regex is — and so is a re-lifted menu document, which every mounted frame already holds.
// All four therefore reload the chat, and this names which one asked so the log says why a reload
// happened. Returns '' when nothing rendered moved: an unchanged re-apply (every dev-loop connect on
// an untouched workspace) must cost no reload at all.
export function menuReloadReason({ layoutChanged, engineChanged, regexesChanged, bodyChanged } = {}) {
    const parts = [];
    if (layoutChanged) parts.push('the layout changed');
    if (engineChanged) parts.push('the engine text changed');
    if (regexesChanged) parts.push('the regexes changed');
    if (bodyChanged) parts.push('the menu document changed');
    return parts.join(' and ');
}

export function layoutFormatterNames(layout) {
    const names = new Set();
    walkLayout(layout, (node) => {
        const f = node.formatters;
        if (!f || typeof f !== 'object' || Array.isArray(f)) return;
        for (const v of Object.values(f)) if (typeof v === 'string' && v.trim()) names.add(v.trim());
    });
    return [...names].sort();
}

// The names the layout wants and the engine does not export. NEVER a refusal (§10a): the menu still
// renders, each miss warns once, and this list is also the LED's honesty about a half-uploaded pair.
export function missingFormatterNames(layout, exportedNames) {
    const have = new Set((exportedNames || []).map(String));
    return layoutFormatterNames(layout).filter((n) => !have.has(n));
}

// Every action NAME a layout DECLARES, deduped and sorted — the write half of the same cross-check.
// Two sites declare one, and both write it as a literal string the way a cell writes a formatter
// name: a list cell's `rowActions[].action` (the verbs its rows offer) and an ActionButton's
// `action`. Read, never interpreted — this side has no idea what "equip" means, only that the
// layout promised a button posting it.
//
// ▲ WHAT THIS DELIBERATELY DOES NOT COUNT: the four verbs a renderer posts from a cell's SHAPE
// rather than from a declared name — a checkbox's setValue, an image's setPortrait, allowEdit's
// editListItem, allowDelete's deleteListItem. Those names are the RENDERER's contract with its own
// runtime, not the layout's vocabulary, and deriving them here would mean this file knowing that a
// `Checkbox` cell posts `setValue` — a renderer's private wiring inside the host, which is the one
// thing `layoutKind` exists to keep out (a second kind would wire the same cell differently, and
// this check would then be wrong for it). When the engine exports NOTHING the warning says so
// outright, which covers those four without naming any of them.
export function layoutActionNames(layout) {
    const names = new Set();
    const add = (v) => { if (typeof v === 'string' && v.trim()) names.add(v.trim()); };
    walkLayout(layout, (node) => {
        // A bare `action` counts only on a CELL. walkLayout descends into every key, so without the
        // `type` test a static arg spelled `args: { "action": "attack" }` — ordinary authored JSON —
        // would read as a promised verb and warn for an action nothing ever posts.
        if (typeof node.type === 'string') add(node.action);
        if (!Array.isArray(node.rowActions)) return;
        for (const entry of node.rowActions) if (entry && typeof entry === 'object') add(entry.action);
    });
    return [...names].sort();
}

// The action names the layout declares and the engine does not export. Same stance as the formatter
// half and for the same reason (§10a): NEVER a refusal — a menu whose buttons refuse still shows
// every value it draws, and half a menu beats none.
export function missingActionNames(layout, exportedNames) {
    const have = new Set((exportedNames || []).map(String));
    return layoutActionNames(layout).filter((n) => !have.has(n));
}

// ── the patch guard (§9.4, G3.5) ─────────────────────────────────────────────

// The shape an action's returned patch must have. UNRESTRICTED in scope and logged by the applier —
// §9.4 deleted the path fence deliberately (a menu draws the active game's variables wherever they
// live, and `packRoots` was a cross-layer reach that nothing ever declared; L7) — so what this guard
// refuses is MALFORMEDNESS only: a patch the applier could not perform faithfully. One bad patch
// refuses the WHOLE action (an action is one user gesture; applying half of it would leave state the
// author never designed), and the reason names the offender.
// A path segment is a stat_data KEY, and a key may be written in any script — an item or skill named in the
// story's own language, with a space or a 「：」 in it. toMvuPatchOps escapes every segment into the JSON Pointer
// MVU reads, so the only segments refused are the ones no dotted path can address faithfully: an empty one
// (a key containing "." splits into two), and a prototype key (isPrototypeKey).
export function menuPatchProblem(patch, index) {
    const at = 'patch[' + index + ']';
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return at + ' is not an object';
    if (patch.op !== 'set' && patch.op !== 'delete') return at + ' has op ' + JSON.stringify(patch.op) + ' — an action patch is { op: "set" | "delete", path, value? }';
    const segments = typeof patch.path === 'string' ? patch.path.split('.') : [];
    if (!segments.length || segments.some((s) => !s)) {
        return at + ' has a malformed path ' + JSON.stringify(patch.path) + ' — a dotted stat_data path ("YourRoot.Inventory.Item") with no empty segment; a key may be in any script but cannot contain "."';
    }
    const prototypeKey = segments.find(isPrototypeKey);
    if (prototypeKey) return at + ' has a malformed path ' + JSON.stringify(patch.path) + ' — "' + prototypeKey + '" is a prototype key, never a stat_data key';
    if (patch.op === 'set' && patch.value === undefined) return at + ' ("' + patch.path + '") sets no value — use op "delete" to remove';
    return '';
}

// Validate a whole returned patch list. Returns { ok, patches, reason } — reason names the FIRST
// offender (one is enough to refuse; the console shows the full return for the rest).
export function validateMenuPatches(patches) {
    if (!Array.isArray(patches)) return { ok: false, patches: [], reason: 'the action returned ' + JSON.stringify(patches) + ' instead of a patch array' };
    for (let i = 0; i < patches.length; i++) {
        const problem = menuPatchProblem(patches[i], i);
        if (problem) return { ok: false, patches: [], reason: problem };
    }
    return { ok: true, patches, reason: '' };
}

// ── the action request (G3.5) ────────────────────────────────────────────────

// The postMessage `type` a menu sends to ask for an action. PUBLISHED — the wire is stated in
// `plans/executed/gamelogic-pack-v2.md` §9a, so any menu may speak it and this host cannot tell a
// hand-written one from a generated one. The builder's suite pins the doc's literal, this constant
// and its own runtime's together, so no two of the three can drift into agreement without the third.
export const MENU_ACTION_MESSAGE = 'mvu-statusmenu-action';

// Read an inbound window message. THREE outcomes, deliberately distinct — the window carries traffic
// from SillyTavern, other extensions and every iframe on the page, so "not addressed to us" must never
// look like "addressed to us and wrong":
//   { mine: false }                          → ignore in silence; not our message
//   { mine: true, ok: false, reason }        → ours and malformed; the caller says so LOUDLY
//   { mine: true, ok: true, action, args, requestId }
//
// `args` is normalised to an object because the engine contract is (args, statSnapshot) and an action
// destructuring `{ itemKey }` must not throw on a menu that sent nothing. `requestId` is optional and
// echoed back verbatim so a menu can match a reply to its click; it is never interpreted here.
// The FORMATTER batch message (§9 pre-pass, B2's seam). The renderer in the menu iframe builds the
// requests — which cells exist, and what `stat` means for each, are its questions — and this side
// resolves the declared scope paths and routes ONE Worker batch. PUBLISHED in §9a with the other two;
// the builder's suite pins the doc's literal against this one and its own PACK_FORMATTER_MESSAGE.
export const MENU_FORMATTER_MESSAGE = 'mvu-helper:statusmenu-formatters';

// A window message can carry anything, and this one reaches runMenuFormatterPrePass, so the shape is
// checked field by field with the offender named. Same three outcomes as the action reader. The cap
// bounds a runaway sender (a real menu resolves a few dozen cells): the whole batch is refused rather
// than truncated, because a silently shortened batch would render SOME cells and read as a menu bug.
const FORMATTER_BATCH_CAP = 512;

export function readMenuFormatterRequest(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return { mine: false };
    if (message.type !== MENU_FORMATTER_MESSAGE) return { mine: false };
    const requests = message.requests;
    if (!Array.isArray(requests) || !requests.length) {
        return { mine: true, ok: false, reason: 'the batch carries no requests (expected a non-empty "requests" array)' };
    }
    if (requests.length > FORMATTER_BATCH_CAP) {
        return { mine: true, ok: false, reason: 'the batch carries ' + requests.length + ' requests — the cap is ' + FORMATTER_BATCH_CAP };
    }
    const clean = [];
    for (let i = 0; i < requests.length; i++) {
        const r = requests[i];
        if (!r || typeof r !== 'object' || Array.isArray(r)) {
            return { mine: true, ok: false, reason: 'requests[' + i + '] is not an object' };
        }
        for (const field of ['cellId', 'field', 'formatterName']) {
            if (typeof r[field] !== 'string' || !r[field].trim()) {
                return { mine: true, ok: false, reason: 'requests[' + i + '] needs a non-empty string "' + field + '"' };
            }
        }
        // The name is addressed as formatters.<name> and nothing else — a dotted name would reach
        // past that namespace, exactly the action reader's rule.
        if (!/^[A-Za-z0-9_$-]+$/.test(r.formatterName)) {
            return { mine: true, ok: false, reason: 'requests[' + i + '] formatter name ' + JSON.stringify(r.formatterName) + ' is not a plain name' };
        }
        if (r.scopePath !== undefined && typeof r.scopePath !== 'string') {
            return { mine: true, ok: false, reason: 'requests[' + i + '] "scopePath", when present, must be a string (the dotted path whose value scopes the formatter)' };
        }
        clean.push({ cellId: r.cellId, field: r.field, formatterName: r.formatterName, scopePath: r.scopePath || '' });
    }
    return { mine: true, ok: true, requests: clean, requestId: message.requestId };
}

// The dotted read a request's scopePath asks for — the RAW subtree, tuples intact: unwrapping is the
// formatter's own business (its getV already does), and a platform-side unwrap would hand School's
// formatters a different shape than their `customLogic` bodies received. Empty path = the snapshot. A
// prototype key reads nothing (shared/object-path.js says why).
function readScopeValue(statData, path) {
    let cur = statData;
    for (const seg of String(path || '').split('.')) {
        if (!seg) return cur;
        if (cur == null || typeof cur !== 'object' || isPrototypeKey(seg)) return undefined;
        cur = cur[seg];
    }
    return cur;
}

// The Worker calls one formatter batch makes, one per request, in request order. A formatter is
// handed (stat, root, scopePath): `stat` the value at the request's scopePath, `root` the whole
// snapshot, and `scopePath` itself — the path `stat` was read from, which is how a formatter drawing
// one item of a collection knows WHICH item. This side gives the path no meaning: the renderer built
// it, and what its segments are is the renderer's and the formatter's business.
export function menuFormatterCalls(statData, requests) {
    return (Array.isArray(requests) ? requests : []).map((r) => ({
        name: 'formatters.' + r.formatterName,
        args: [readScopeValue(statData, r.scopePath), statData, String(r.scopePath || '')],
    }));
}

export function readMenuActionRequest(message) {
    return readActionAddressedMessage(message, MENU_ACTION_MESSAGE);
}

// ── the inputs request (D8) ──────────────────────────────────────────────────
// What a verb NEEDS from the player is the engine's answer, given at click time: `inputs.<name>(args,
// root)` returns a declaration the menu's one generic form draws. This side verifies the wire and
// the SHAPE — the four kinds the form can draw, names that can be args keys, a pick that has options
// — and relays the rest verbatim: which options exist, what they mean, and why, are the engine's
// business (§B.7e.7). Same three outcomes and the same name rule as the action request, because it
// addresses the same surface.
export const MENU_ACTION_INPUTS_MESSAGE = 'mvu-statusmenu-action-inputs';

// The closed list of kinds the menu's form draws. PUBLISHED in §9a, order included; the builder's
// suite pins the doc's list against this one and its own MENU_INPUT_KINDS.
export const MENU_INPUT_KINDS = ['pick', 'number', 'text', 'boolean'];

export function readMenuActionInputsRequest(message) {
    return readActionAddressedMessage(message, MENU_ACTION_INPUTS_MESSAGE);
}

function readActionAddressedMessage(message, type) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return { mine: false };
    if (message.type !== type) return { mine: false };
    const action = message.action;
    if (typeof action !== 'string' || !action.trim()) {
        return { mine: true, ok: false, reason: 'the request names no action (expected a non-empty "action" string)' };
    }
    // A dotted name would reach past `actions.` into another namespace — the engine surface is
    // addressed as actions.<name> and nothing else, so the name itself must be one plain segment.
    if (!/^[A-Za-z0-9_$-]+$/.test(action)) {
        return { mine: true, ok: false, reason: 'action name ' + JSON.stringify(action) + ' is not a plain name' };
    }
    const args = message.args;
    return {
        mine: true,
        ok: true,
        action,
        args: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {},
        requestId: message.requestId,
    };
}

const isScalar = (v) => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

// The shape ONE declared input must have. Refuses malformedness the form could not draw faithfully —
// never the content: an option's meaning, a label's wording, why a candidate is offered, are the
// engine's. One bad input refuses the WHOLE declaration (menuPatchProblem's posture — a half-drawn
// form asks for half a verb), and the reason names the offender.
export function menuInputProblem(input, index) {
    const at = 'inputs[' + index + ']';
    if (!input || typeof input !== 'object' || Array.isArray(input)) return at + ' is not an object';
    if (typeof input.name !== 'string' || !/^[A-Za-z0-9_$-]+$/.test(input.name)) return at + ' has no plain name — it becomes the args key the action reads';
    const named = at + ' ("' + input.name + '")';
    if (input.name === 'scopePath') return named + ' is named "scopePath", which the renderer reserves';
    if (!MENU_INPUT_KINDS.includes(input.kind)) return named + ' has kind ' + JSON.stringify(input.kind) + ' — the form draws ' + MENU_INPUT_KINDS.join(', ');
    if (input.label !== undefined && typeof input.label !== 'string') return named + ' label must be a string';
    if (input.kind === 'pick') {
        if (!Array.isArray(input.options) || !input.options.length) return named + ' is a pick with no options';
        for (let j = 0; j < input.options.length; j++) {
            const option = input.options[j];
            const value = (option && typeof option === 'object' && !Array.isArray(option)) ? option.value : option;
            if (!isScalar(value)) return named + ' option[' + j + '] has no scalar value';
        }
    }
    return '';
}

// Validate a whole returned declaration. Returns { ok, inputs, reason } — reason names the FIRST
// offender, as validateMenuPatches does.
export function validateMenuInputs(inputs) {
    if (!Array.isArray(inputs)) return { ok: false, inputs: [], reason: 'the inputs declaration is ' + JSON.stringify(inputs) + ' instead of an array' };
    for (let i = 0; i < inputs.length; i++) {
        const problem = menuInputProblem(inputs[i], i);
        if (problem) return { ok: false, inputs: [], reason: problem };
    }
    return { ok: true, inputs, reason: '' };
}

// Translate VALIDATED menu patches into the ops `Mvu.parseMessage` takes. The two vocabularies differ
// and this is the only place that knows both: a menu action speaks `{op:'set'|'delete', path:'A.B.C'}`
// because that is what reads naturally to a menu author, while MVU takes JSON-Patch verbs on
// JSON-Pointer paths (`shared/json-patch-ops.js` PATCH_VERBS).
//
// `set` becomes `add`, NOT `replace`: replace requires the member to exist already, and a menu action
// legitimately creates one (the probe's equip writes an Equipment slot that may never have been set).
// `add` onto an existing object member replaces it, so `add` covers both and `replace` covers half.
// Whether MVU then KEEPS the value is its own business — the caller reports what did not land rather
// than predicting it here (opsOutcomeAfterApply, which compares the stored value against what was sent).
// Each key is escaped per RFC 6901 ("~" → "~0", "/" → "~1") — MVU decodes the same two — so a key holding a "/"
// stays one key instead of splitting.
export function toMvuPatchOps(patches) {
    return (patches || []).map((patch) => {
        const pointer = '/' + String(patch.path).split('.').map((key) => key.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
        return patch.op === 'delete'
            ? { op: 'remove', path: pointer }
            : { op: 'add', path: pointer, value: patch.value };
    });
}

// ── LED (§6/G3.7) ────────────────────────────────────────────────────────────

// The shared LED with this lane's owned slot, its engine entry (menuOwnedSlots), plus the dimension only this lane has:
// an OWNED lifted menu document that is absent is a missing piece (red), exactly as a missing layout entry or a missing
// owned engine is — without the engine the menu renders but every formatter falls to raw; without the document the
// marker row has nothing to mount. Both are broken installs, not style choices. The comments join `missing` so the UI
// names what to reinstall; neither rides installedComments, because the sweep cannot see [MVU_StatusMenuEngine] or
// [MVU_StatusMenuBody] and the V3 exactness count would disagree forever.
export function deriveMenuLed({ inLibrary, isActive, recordedComments, presentComments, recordedRegexNames, presentRegexNames, regexReadable = true, ownedSlots = [], liftedRows = [], presentBodyRows = [] } = {}) {
    const led = deriveArtifactLed({ inLibrary, isActive, recordedComments, presentComments, recordedRegexNames, presentRegexNames, regexReadable, ownedSlots });
    if (!isActive) return led;
    const present = new Set((Array.isArray(presentBodyRows) ? presentBodyRows : []).map(String));
    const missingBodies = (Array.isArray(liftedRows) ? liftedRows : []).filter((row) => !present.has(String(row))).map(menuBodyComment);
    if (missingBodies.length) return { ...led, state: 'red', missing: [...led.missing, ...missingBodies] };
    return led;
}

// The menu's owned slot, for that LED: the [MVU_StatusMenuEngine] entry, with the fingerprint its install recorded and
// the text the card holds now, from readMenuEngineCode's tri-state: null (the book did not answer) is could not look,
// an entry not found is empty.
export function menuOwnedSlots(registry, engineRead) {
    const text = engineRead === null || engineRead === undefined ? undefined : (engineRead.found ? String(engineRead.text) : null);
    return [{ name: '[MVU_StatusMenuEngine]', isOwned: registry.engineOwned === true, recordedFingerprint: registry.engineFingerprint, text }];
}

// The StatusMenu Engine dev upload's status, from readMenuEngineCode: the stored engine as a row (its declared version and
// its size), or an empty state saying why there is none. Nothing while the card cannot be read — no chat, or a lorebook
// that does not answer: the tab's notices say why, and some of those reasons never pass, so "Refresh tries again" would
// contradict them. Returns { row } | { empty } | null.
export function menuEngineStatusView({ isCardReadable = false, read = null } = {}) {
    if (!isCardReadable) return null;
    if (read === null) return { empty: { text: "The card's lorebook is not ready yet. Refresh tries again.", icon: 'fa-hourglass-half' } };
    if (!read.found) return { empty: { text: 'No StatusMenu Engine on this card.', icon: 'fa-file-circle-xmark' } };
    const size = (String(read.text).length / 1024).toFixed(1) + ' KB';
    return { row: { icon: 'fa-file-code', name: '[MVU_StatusMenuEngine]', sub: { text: 'Installed', name: `${declaredVersionOf(read.text) || '?'} · ${size}` } } };
}

// ── G4: the pack-host shell — one placeholder owner per card (§11) ───────────

// The trigger every menu regex fires on: MVU's own placeholder (sillytavern/mvu-bridge-core.js spells it, for
// every module that places text around it). The shell replaces it with the menu body; anything else enabled that
// ALSO matches it wins or loses by list position silently — the first-wins death §B.1 measured, which is why the
// disposition below never installs a second claimant.
export { MENU_PLACEHOLDER };

// The script_name of the marker-last row mvu-helper installs BESIDE every menu's own regexes
// (statusmenu-pack-marker-last.js builds the row itself). It lives here, with the placeholder it
// serves, because two lanes need the NAME without needing the row: the marker builder, and the W6
// export, which must leave it behind. A published lifecycle key — regex install, replace and removal
// all match on it — so it does not change.
export const MARKER_LAST_REGEX_NAME = 'StatusMenu Keep Last';

// Would this find_regex fire on the placeholder? Mirrors ST's regexFromString: '/p/flags' compiles
// as a regex, anything else is used as a bare pattern. A pattern that does not compile is NOT a
// claimant — ST's own engine would not run it either, so counting it would invent a conflict over a
// regex that never fires. (EXPECTED, not a swallow: the uncompilable pattern is already surfaced by
// rule 10's compile warning at import.)
function matchesPlaceholder(findRegex) {
    const raw = String(findRegex || '');
    if (!raw) return false;
    try {
        const m = raw.match(/^\/(.+)\/([a-z]*)$/is);
        const re = m ? new RegExp(m[1], m[2].replace('g', '')) : new RegExp(raw);
        return re.test(MENU_PLACEHOLDER);
    } catch (_e) {
        return false;   // EXPECTED: does not compile ⇒ never fires in ST ⇒ not a claimant
    }
}

// Does this row run on the NEWEST message — the only one where a menu is ever drawn?
//
// SillyTavern skips a script when `depth < minDepth` (regex/engine.js:363), and the newest message is
// depth 0, so any positive min_depth puts the row permanently out of the menu's way. max_depth cannot
// exclude depth 0 at all: its own guard requires `maxDepth >= 0`, and `0 > maxDepth` is then never
// true. Both spellings are read because the field arrives as `min_depth` through TavernHelper and as
// `minDepth` inside SillyTavern.
//
// WHY THIS IS PART OF THE CLAIMANT TEST (live 2026-08-31): School's `HideFarFloor` is `/.*/s` with an
// empty replacement and `min_depth: 10` — it blanks the DISPLAY of old messages. Its pattern does
// match the placeholder, so a purely textual test called it a second claimant and G4 stood its own
// install down over a regex that can never touch the message the menu lives on. A conflict warning
// that fires on a non-conflict is how a real one stops being read.
function runsOnNewestMessage(row) {
    const raw = row && (row.min_depth !== undefined ? row.min_depth : row.minDepth);
    const min = Number(raw);
    if (raw === null || raw === undefined || Number.isNaN(min)) return true;   // no floor ⇒ runs everywhere
    if (min < -1) return true;                                                 // ST ignores the field below -1
    return min <= 0;
}

// Every ENABLED regex on the card that would fire on the placeholder IN THE PLACE A MENU RENDERS, by
// name, in apply order. Disabled rows are not claimants — disabling is exactly how a user parks a
// second menu — and neither are rows fenced to older messages by min_depth.
export function placeholderClaimants(cardRegexes) {
    return (Array.isArray(cardRegexes) ? cardRegexes : [])
        .filter((r) => r && r.enabled !== false && runsOnNewestMessage(r) && matchesPlaceholder(r.find_regex))
        .map((r) => String(r.script_name || ''));
}

// Should the bare-card shell be installed? The one decision of the G4 lane, pure so it is testable
// without a card (L6). `claimants` from placeholderClaimants, `shellName` the shell's script_name.
//   install  — no claimant: the card renders nothing until the shell exists, write it
//   present  — the shell is the ONLY claimant: nothing to do
//   owned    — ONE claimant and it is not ours: a pack shipped its own menu shell, or the card's
//              owner parked one there. Nothing is wrong and nothing is installed. This is the
//              ORDINARY outcome for a pack that carries a `regex` section, so it must not read as a
//              problem — say who owns the placeholder and stop.
//   conflict — TWO OR MORE claimants fire: first-in-list is already deciding which menu the card
//              renders, silently. That is the one case worth a warning and worth advice.
//
// THE MARKER-LAST ROW IS NOT A CLAIMANT. `withMarkerLastRow` writes it in the same syncRegexes call
// as the menu's own regexes, to push the placeholder to the end; it renders nothing. Counting it
// made every correct install report "MULTIPLE enabled claimants" and advise removing a row this
// installer had just written and still needs (live, ArtificKoi, 2026-09-06). The W6 export already
// drops it by name for the same reason — it is mvu-helper's bookkeeping, never menu data.
export function shellInstallDisposition({ claimants, shellName } = {}) {
    const names = (Array.isArray(claimants) ? claimants : [])
        .filter(Boolean)
        .filter((n) => String(n) !== MARKER_LAST_REGEX_NAME);
    const foreign = names.filter((n) => n !== String(shellName || ''));
    if (names.length > 1) {
        return {
            action: 'conflict',
            reasons: ['the placeholder ' + MENU_PLACEHOLDER + ' has MULTIPLE enabled claimants on this card: '
                + names.join(', ') + ' — one card renders ONE menu, and first-in-list wins silently.'
                + ' Disable or remove the extra claimant' + (names.length > 2 ? 's' : '') + ', or keep the card\'s own.'],
        };
    }
    if (foreign.length) {
        return {
            action: 'owned',
            reasons: ['the placeholder ' + MENU_PLACEHOLDER + ' is owned by "' + foreign[0]
                + '" — this card already renders a menu of its own, so the built-in placeholder shell was not installed.'],
        };
    }
    return names.length ? { action: 'present', reasons: [] } : { action: 'install', reasons: [] };
}

// ── W6: release export — the menu pack file back from the card (§8) ──────────

// The shared artifact export (card-artifact-store buildArtifactExportFile) plus what only a menu has:
// the layout entry, a recorded comment that is a SECTION (its content parses back to `layout`), and
// regex rows the card holds in another form.
//
// TWO platform-owned rows can sit among a card's menu regexes, and NEITHER is pack data:
//   • the shellOwned placard — only ever written when the pack ships no regexes, so the walk cannot
//     meet it (it is not recorded in installedRegexNames either);
//   • the MARKER-LAST row — written by install in the SAME syncRegexes call as the pack's own rows, and
//     recorded in installedRegexNames precisely so uninstall takes it away again.
// The second one the walk DOES meet, so it is skipped by name. It is absent from the registry's
// regexOrder (that records the pack's declaration), and shipping it would both fail rule 14 and put
// mvu-helper's row inside a consumer's artifact. Re-install puts it back.
//
// M2: the card holds every lifted row in MARKER form; the documents are the [MVU_StatusMenuBody:<row>]
// texts, put back verbatim so the exported rows are the shipped rows.
export function buildMenuExportFile({ registry, entries, engineText, cardRegexes, menuBodies } = {}) {
    const reg = registry || {};
    if (!reg.activeMenuId) return { pack: null, errors: ['no StatusMenu Pack is active on this card — nothing to export'] };
    return buildArtifactExportFile({
        artifactType: STATUSMENU_TYPE, id: reg.activeMenuId, record: reg, entries,
        identityFix: 're-install the menu once so they are recorded',
        sections: [{ comment: menuLayoutComment(reg.activeMenuId), field: 'layout', json: true, label: 'installed (Layout) entry' }],
        engineText, engineSource: '[MVU_StatusMenuEngine]',
        cardRegexes, skipRegexNames: [MARKER_LAST_REGEX_NAME],
        restoreRegexRows: (rows) => restoreLiftedMenuRows(rows, menuBodies),
    });
}

// ── the LIFT (plans/executed/statusmenu-containment.md M2) — nothing this lane writes reaches TavernHelper ──
//
// TavernHelper renders every <pre> whose text carries one of its tokens (isTavernHelperFrontendText)
// into an iframe with the page's full authority, and a pack's regex rows are exactly where a menu
// document arrives. So at install the ONE fenced document is lifted OUT of its row into
// [MVU_StatusMenuBody] and the row written to the card is the MARKER form: the region container, no
// fence, naming the pack. Every written row is then held to TavernHelper's own predicate, and a row
// that still trips it REFUSES THE INSTALL (D9): a warned pass-through would be the bypass the
// containment exists to close. The pack file is never rewritten; re-apply compares the transformed rows.

// The two attributes a marker-form row carries: which PACK it came from, and which ROW (script_name) —
// the frame mount finds the container by the first and its document by the second. A pack may ship
// several wrapped rows in several regions (School ships a game-start form beside the menu); each keeps
// its own region name, and each is lifted on its own.
export const MENU_MOUNT_ATTRIBUTE = 'data-mvu-helper-menu';
export const MENU_MOUNT_ROW_ATTRIBUTE = 'data-mvu-helper-menu-row';

// The marker-form replace_string: the row's own region container with no fence, naming pack and row.
export function menuMarkerRowText(packId, regionName, rowName) {
    return wrapRenderedRegion(regionName, '', { [MENU_MOUNT_ATTRIBUTE]: String(packId || ''), [MENU_MOUNT_ROW_ATTRIBUTE]: String(rowName || '') });
}

// The row name a marker-form text names — the inverse of the attribute the marker carries.
export function menuMarkerRowName(text) {
    const m = String(text == null ? '' : text).match(new RegExp(' ' + MENU_MOUNT_ROW_ATTRIBUTE + '="([^"]*)"'));
    if (!m) return '';
    return m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// A fence line at column 0 — the shape wrapRenderedRegion, the builder and markdown all agree on.
function hasFenceLine(text) {
    return String(text == null ? '' : text).split('\n').some((line) => line.startsWith('```'));
}

// A row this lane wrote in marker form: carries the mount attribute and no fence.
export function isMenuMarkerRowText(text) {
    const s = String(text == null ? '' : text);
    return s.includes(' ' + MENU_MOUNT_ATTRIBUTE + '="') && !hasFenceLine(s);
}

// Decide what the card gets for the rows a pack ships.
// Returns { ok: true, rows, lifted } — `rows` is what syncRegexes writes (every fenced row in marker
// form, every other row untouched) and `lifted` is [{ name, regionName, text }] per fenced row, `text`
// being that row's replace_string VERBATIM (empty when the pack ships no document, e.g. the placeholder
// shell) — or { ok: false, reason } naming the row and what was found. Pure and idempotent: the marker
// form carries no fence, so lifting the output again lifts nothing and changes nothing, which is what
// keeps a re-apply byte-stable.
export function liftMenuRegexRows(rows, packId) {
    const list = Array.isArray(rows) ? rows : [];
    const out = [];
    const lifted = [];
    for (const row of list) {
        const name = String((row && row.script_name) || '');
        const text = String((row && row.replace_string) || '');
        if (!hasFenceLine(text)) { out.push(row); continue; }
        const regionName = detectRegionName(text);
        if (!regionName) {
            return { ok: false, reason: 'regex "' + name + '" carries a fenced block outside a rendered-region wrapper (no single mvu-helper:begin marker) — it cannot be lifted out of TavernHelper\'s reach. Wrap it the way MvuStatMenuBuilder wraps the menu: the region container, the marker pair, ONE fenced document, nothing else.' };
        }
        const { body, problem } = unwrapRenderedRegion(text, regionName);
        if (problem) {
            return { ok: false, reason: 'regex "' + name + '" cannot be lifted out of TavernHelper\'s reach — ' + problem + '. The row must be exactly the region container, the marker pair, ONE fenced document, nothing else (what MvuStatMenuBuilder exports).' };
        }
        if (!body.trim()) return { ok: false, reason: 'regex "' + name + '" carries an EMPTY fenced block — nothing to lift and nothing to render.' };
        if (lifted.some((l) => l.name === name)) return { ok: false, reason: 'regex "' + name + '" appears twice — a row name is the document\'s identity on the card.' };
        lifted.push({ name, regionName, text });
        out.push({ ...row, replace_string: menuMarkerRowText(packId, regionName, name) });
    }
    // THE INVARIANT, on what is actually written — every row, lifted or not.
    for (const row of out) {
        const text = String((row && row.replace_string) || '');
        if (isTavernHelperFrontendText(text)) {
            const token = TAVERNHELPER_FRONTEND_TOKENS.find((t) => text.includes(t));
            return { ok: false, reason: 'regex "' + String((row && row.script_name) || '') + '" carries ' + JSON.stringify(token) + ' outside a lifted fence — TavernHelper would render it on the card with the page\'s full authority, so the install is refused. Move it inside a fenced, wrapped document, or remove it.' };
        }
    }
    return { ok: true, rows: out, lifted };
}

// What the install warning reads of a StatusMenu Pack (installReachTexts): its entries, and its regex rows as the card
// gets them, each fenced document lifted out and its row left as the marker that names the pack and the row. A lifted
// document, the layout and the engine are written as silent entries holding data for the menu, and are not read. A
// pack whose rows cannot be lifted is refused by its install, and its rows are read as shipped.
export function menuReachTexts(pack) {
    const lift = liftMenuRegexRows(pack && pack.regex, pack && pack.id);
    return installReachTexts({ entries: pack && pack.entries, regexRows: lift.ok ? lift.rows : pack && pack.regex });
}

// The inverse for the release export: every marker-form row gets its verbatim text back, from
// `menuBodies` ({ [rowName]: text } — what the [MVU_StatusMenuBody:<row>] entries hold).
// Returns { rows, problem } — `problem` when a marker row is on the card and there is no text to put
// back: export never invents a document, and shipping the marker form would ship a pack with a hole.
export function restoreLiftedMenuRows(rows, menuBodies) {
    const list = Array.isArray(rows) ? rows : [];
    const bodies = menuBodies && typeof menuBodies === 'object' ? menuBodies : {};
    const out = [];
    for (const row of list) {
        const text = row && row.replace_string;
        if (!isMenuMarkerRowText(text)) { out.push(row); continue; }
        const rowName = menuMarkerRowName(text) || String((row && row.script_name) || '');
        const body = typeof bodies[rowName] === 'string' ? bodies[rowName] : '';
        if (!body) {
            return { rows: list, problem: 'regex "' + String((row && row.script_name) || '') + '" is a lifted row, but ' + menuBodyComment(rowName) + ' is empty or unreadable — export cannot invent the document, so it refuses' };
        }
        out.push({ ...row, replace_string: body });
    }
    return { rows: out, problem: null };
}

// The silent entry a lifted row's text lives in: '[MVU_StatusMenuBody:<row script_name>]'. One per
// row, because a pack may ship several documents and each mounts on its own.
export const MENU_BODY_ENTRY_PREFIX = '[MVU_StatusMenuBody:';
export function menuBodyComment(rowName) {
    return MENU_BODY_ENTRY_PREFIX + String(rowName == null ? '' : rowName) + ']';
}
// The row name a body entry's comment carries, or '' for a comment that is not one.
export function menuBodyRowName(comment) {
    const s = String(comment == null ? '' : comment);
    const at = s.toLowerCase().indexOf(MENU_BODY_ENTRY_PREFIX.toLowerCase());
    if (at === -1) return '';
    const rest = s.slice(at + MENU_BODY_ENTRY_PREFIX.length);
    const close = rest.lastIndexOf(']');
    return close === -1 ? '' : rest.slice(0, close);
}

// ── M7: the gate's edge, named ───────────────────────────────────────────────

// Every enabled row on the card that still carries what TavernHelper renders and is this lane's
// business. Two verdicts, because two different people fix them:
//   'pre-lift'     the registry records the row — this lane wrote it, before the lift existed
//                  (any recorded row, whatever it fires on). The fix is a re-activation; there is
//                  no migration, mvu-helper is unreleased.
//   'uncontained'  an enabled claimant of the menu placeholder the registry does not record — pasted
//                  by hand, imported from a pre-lift export, another tool's. TavernHelper renders it
//                  with the page's full authority and mvu-helper cannot contain what it did not
//                  write; it can only say so.
// A foreign row that fires on anything OTHER than the placeholder is not a menu and is not audited —
// a card's own frontends (galgame is one) are the card owner's choice, not this lane's business.
export function auditMenuRows({ cardRegexes, installedRegexNames } = {}) {
    const list = Array.isArray(cardRegexes) ? cardRegexes : [];
    const claimants = new Set(placeholderClaimants(list));
    const installed = new Set((Array.isArray(installedRegexNames) ? installedRegexNames : []).map(String));
    const findings = [];
    for (const row of list) {
        if (!row || row.enabled === false) continue;
        const name = String(row.script_name || '');
        if (!isTavernHelperFrontendText(row.replace_string)) continue;
        if (installed.has(name)) findings.push({ name, verdict: 'pre-lift' });
        else if (claimants.has(name)) findings.push({ name, verdict: 'uncontained' });
    }
    return findings;
}
