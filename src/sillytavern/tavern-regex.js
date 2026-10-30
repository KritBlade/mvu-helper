// sillytavern/tavern-regex.js — the ONLY place mvu-helper writes regexes. TWO host APIs, split by scope:
// CHARACTER goes through SillyTavern's own regex engine (see the §11 block further down for why), GLOBAL
// still goes through TavernHelper. The API notes below describe the TavernHelper half.
//
// WHY THIS EXISTS (GameLogic Pack plan §11): a card's display regexes are part of the GAME, not part of the
// card — hiding an <UpdateVariable> block or a <think> section is the pack's presentation of its own output.
// They live in `data.extensions.regex_scripts[]`, which no lorebook entry can reach, so the pack lane needs
// a host wrapper of its own.
//
// API (read from JS-Slash-Runner src/function/tavern_regex.ts, not from its doc comment):
//   getTavernRegexes({type})                 → TavernRegex[]   — SYNCHRONOUS, despite reading like a fetch
//   updateTavernRegexesWith(updater, {type}) → Promise<TavernRegex[]>
//   replaceTavernRegexes(regexes, {type})    → Promise<void>   — wholesale replace; not used here
//
// ⚠ CORRECTION TO THE PLAN'S API NOTE. §11 recorded "updateTavernRegexesWith for targeted writes;
// replaceTavernRegexes RELOADS the whole chat — install-time only". The first half is wrong in the way that
// matters: `updateTavernRegexesWith` is literally get → updater → `replaceTavernRegexes`, so it is just as
// expensive. There is NO cheap write on this surface. (What replaceTavernRegexes actually ends in is
// render_tavern_regexes — refresh every rendered message, then EMIT CHAT_CHANGED (tavern_regex.ts:249) —
// not reloadCurrentChat. Same cost, and the emit is the part that matters: it is what used to refresh
// SillyTavern's regex list for us, and what the character path now does deliberately in refreshRegexUi.)
// Consequences, both load-bearing:
//   • Write ONCE per operation, never once per regex — hence every function here takes the whole list.
//   • The reload emits CHAT_CHANGED (debounced ~1s), which re-runs every card-sync pass. Those passes are
//     create-only and idempotent, so this is survivable — but it is why no render path may write here.
//
// ⚠ SCOPE OPTION. `{ type: 'character' }` is the current form; the older `{ scope: 'character' }` reaches a
// deprecated branch that partitions on a `scope` field the new API no longer returns. Always pass `type`.
//
// Every DECISION (matching by name, upsert, removal, conflict detection) lives in tavern-regex-core.js so it
// is testable; this file is I/O and logging only.

import { createModuleLog } from './log.js';
import { getContext } from '../../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../../script.js';
import {
    SCRIPT_TYPES,
    allowScopedScripts,
    getScriptsByType,
    regex_placement,
    saveScriptsByType,
} from '../../../../regex/engine.js';
import {
    regexList,
    regexNames,
    removeRegexesByName,
    syncRegexesInList,
    toSillyTavernRegex,
    mergeScopedScripts,
    unchangedScopedNames,
    VERIFY_INSTALL,
    VERIFY_REMOVAL,
} from './tavern-regex-core.js';
import { requestChatReload } from './chat-reload.js';

const log = createModuleLog('tavern-regex');

export const REGEX_SCOPE_CHARACTER = 'character';

// ── CHARACTER REGEXES ARE WRITTEN THE WAY SILLYTAVERN WRITES THEM (§11, 2026-08-24) ─────────────────
// SillyTavern's own regex editor saves a card-scoped script in exactly three steps
// (public/scripts/extensions/regex/index.js:544):
//
//     await saveScriptsByType(array, SCRIPT_TYPES.SCOPED);   // → writeExtensionField → merge-attributes
//     allowScopedScripts(characters?.[this_chid]);           // → character_allowed_regex
//     saveSettingsDebounced();
//
// We now call that same API instead of routing character writes through TavernHelper. Two reasons, both
// found the hard way:
//
//   1. TavernHelper ships its OWN replacement for writeExtensionField which POSTs the entire card to
//      /api/characters/edit on every field update. Its own per-character settings watcher uses that same
//      writer, so two full-card writes can be in flight at once — ours with 14 regexes, its with whatever
//      regex_scripts held when it started. The file has no concurrency control and the last one to finish
//      wins. Captured live: 13:29:46.559 (n=2, the watcher) beat 13:29:46.585 (n=14, this install), and
//      the card lost 12 regexes while memory kept all 14, so every read-back reported success.
//      saveScriptsByType merges the ONE named key and cannot do that to anyone.
//   2. ALLOWING was never done at all. A card-scoped regex is inert unless its avatar is in
//      `character_allowed_regex` — engine.js:166. Every install so far has only worked because these
//      avatars were already on that list from earlier imports; a card with a genuinely new filename would
//      have got all 12 regexes written and none of them running, with nothing anywhere saying why.
//
// The pack format stays TavernHelper-shaped, so the conversion into SillyTavern's shape lives in the core
// (toSillyTavernRegex) beside the merge and the verification — pure, tested, mirroring from_tavern_regex.

// ── AND THE WRITE IS VERIFIED, BECAUSE ONE RACER REMAINS ────────────────────────────────────────────
// Using SillyTavern's targeted save stops US from ever clobbering another key — but it does not stop
// TavernHelper's settings watcher from clobbering OURS. That watcher posts the whole card, so a copy of
// `regex_scripts` taken before our save can still land after it and roll the card back. Repairing that
// watcher is not ours to do; noticing is. Every character write is therefore read back from the CARD,
// and a write that lost the race is re-asserted through the same SillyTavern save.

// The regex names actually PERSISTED on the card file. getTavernRegexes reads
// `characters[id].data.extensions.regex_scripts` — the IN-MEMORY copy — which is exactly why a lost write
// still reads back as installed. Returns null when the card cannot be read (never [], which would read as
// "the card has none" and turn an outage into a false verdict).
export async function persistedCharacterRegexNames() {
    const ctx = typeof getContext === 'function' ? getContext() : null;
    const character = ctx && ctx.characters ? ctx.characters[ctx.characterId] : null;
    if (!character || !character.avatar) {
        log.warn('no character open — cannot read the persisted regex list');
        return null;
    }
    try {
        const res = await fetch('/api/characters/get', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: character.avatar }),
        });
        if (!res.ok) {
            log.warn('could not read the persisted card (HTTP ' + res.status + ') — the write is UNVERIFIED');
            return null;
        }
        const card = await res.json();
        const list = (((card || {}).data || {}).extensions || {}).regex_scripts;
        return Array.isArray(list) ? list.map((r) => String((r && r.scriptName) || '')).filter(Boolean) : [];
    } catch (e) {
        log.warn('reading the persisted card failed — the write is UNVERIFIED:', e);
        return null;
    }
}

// Did the card end up the way we asked, and if not, make it so. ONE routine serves both directions
// because only the question differs: an install is wrong when a name it asked for is ABSENT, an uninstall
// when a name it removed is STILL THERE. The racer, the settle, the repair and the null-vs-empty reasoning
// are identical, and splitting them would let the two drift apart on exactly the details that were
// expensive to learn. Returns { verified, offenders, repaired }: verified=false means we could not look at
// all, which is NOT the same as "the card is wrong".
//
// ⚠ CHECKING TOO EARLY IS THE SAME AS NOT CHECKING. The write that steals ours is issued BEFORE it —
// captured live at 13:29:46.559 against our 13:29:46.585 — and only WINS because it finishes later. A
// verification that runs the instant our own POST resolves can therefore read a correct card and be
// overtaken a moment afterwards, which would let the install report success for a card that ends up
// missing 12 regexes. That is the failure this whole guard exists to stop, so the check has to happen
// after the racing writers have drained, not after ours has returned.
//
// The window is set by TavernHelper's own render debounce (1000 ms): a regex write schedules a deferred
// CHAT_CHANGED, and that event is what wakes the settings watcher whose full-card write does the damage.
// 1500 ms clears it with margin. This is dead time on an INSTALL or UNINSTALL — operations a human just
// clicked and waits on — never on a render path, and it buys a verdict that is true when it is printed.
const WRITE_SETTLE_MS = 1500;
const settle = () => new Promise((resolve) => setTimeout(resolve, WRITE_SETTLE_MS));

async function verifyAndRepairCharacterWrite(names, words) {
    if (!names.length) return { verified: true, offenders: [], repaired: false };

    await settle();
    let onCard = await persistedCharacterRegexNames();
    if (onCard === null) return { verified: false, offenders: [], repaired: false };
    let offenders = words.offendersOn(names, onCard);
    if (!offenders.length) return { verified: true, offenders: [], repaired: false };

    log.warn('' + words.lost(offenders.length) + ' — another full-card write landed on top '
        + 'of ours (' + offenders.join(', ') + '). Re-asserting through the targeted API.');

    // The repair re-asserts what MEMORY holds, which is the whole premise of the bug: our save updated
    // memory and the card, and the racer rolled back only the card. Memory is therefore the correct copy
    // in both directions — for a removal it is the list already missing the names we dropped.
    const ctx = typeof getContext === 'function' ? getContext() : null;
    const character = ctx && ctx.characters ? ctx.characters[ctx.characterId] : null;
    const inMemory = character ? (((character.data || {}).extensions || {}).regex_scripts || []) : null;
    if (!Array.isArray(inMemory)) {
        log.error('cannot re-assert — no in-memory regex list; ' + words.lost(offenders.length));
        return { verified: true, offenders, repaired: false };
    }
    try {
        await saveScriptsByType(inMemory, SCRIPT_TYPES.SCOPED);
    } catch (e) {
        log.error('the re-assert write threw — ' + words.lost(offenders.length) + ':', e);
        return { verified: true, offenders, repaired: false };
    }
    // Same reasoning as the first check: settle before believing the repair, or a straggler write that
    // was already in flight turns a confirmed repair into another silent loss.
    await settle();
    onCard = await persistedCharacterRegexNames();
    if (onCard === null) return { verified: false, offenders, repaired: false };
    offenders = words.offendersOn(names, onCard);
    if (offenders.length) {
        log.error('' + words.stuck(offenders.length) + ' (' + offenders.join(', ')
            + ') — something is writing this card faster than we can');
        return { verified: true, offenders, repaired: false };
    }
    log.lifecycle('' + words.fixed(names.length));
    return { verified: true, offenders: [], repaired: true };
}

// Same resolution ladder as lorebook.js and tavern-script.js: bare global → TavernHelper → parent's bare →
// parent's TavernHelper. (Duplicated deliberately rather than shared — see tavern-script.js's copy for why;
// this is now the THIRD, so extracting it is on the table the next time one is needed. P3 is a rule about
// earning the move, and a fourth consumer earns it.)
function resolveRegexFn(name) {
    if (typeof globalThis !== 'undefined' && typeof globalThis[name] === 'function') return globalThis[name];
    const th = typeof window !== 'undefined' ? window.TavernHelper : undefined;
    if (th && typeof th[name] === 'function') return th[name].bind(th);
    try {
        const p = typeof window !== 'undefined' ? window.parent : undefined;
        if (p && typeof p[name] === 'function') return p[name];
        if (p && p.TavernHelper && typeof p.TavernHelper[name] === 'function') return p.TavernHelper[name].bind(p.TavernHelper);
    } catch (_e) { /* EXPECTED: cross-origin parent access throws — that resolution path is simply unavailable */ }
    return null;
}

// Is the regex API attached RIGHT NOW — both halves?
//
// Same shape and same reason as isScriptApiAvailable: `getTavernRegexes` returns [] both for "this card has
// no regexes" and for "I could not look", and a pack lane that acts on the difference must be able to ASK.
// BOTH functions are required: a reader without a writer can tell you a regex is missing and then fail to
// install it, which looks like a decision rather than an outage.
export function isRegexApiAvailable() {
    return typeof resolveRegexFn('getTavernRegexes') === 'function'
        && typeof resolveRegexFn('updateTavernRegexesWith') === 'function';
}

// A fresh regex id. TavernHelper assigns uuids to regexes created in its own editor; ours only has to be
// unique and recognisable in ST's editor. Kept out of the core so the core stays deterministic under test.
function newRegexId() {
    return 'mvuhelper-' + Math.random().toString(36).slice(2, 10);
}

// Read a scope's regexes. [] when the API is unavailable or the read throws (logged, never silent).
// NOTE the host function is synchronous; this stays async so every call site reads like the script lane's
// and a future async host version needs no caller changes.
export async function getRegexes(scope = REGEX_SCOPE_CHARACTER) {
    const get = resolveRegexFn('getTavernRegexes');
    if (typeof get !== 'function') {
        log.warn('getTavernRegexes API unavailable — cannot read ' + scope + ' regexes');
        return [];
    }
    try {
        return regexList(await get({ type: scope }));
    } catch (e) {
        log.warn('getTavernRegexes(' + scope + ') failed:', e);
        return [];
    }
}

// Every regex NAME in a scope, in apply order. The read most callers actually want — conflict checks and
// uninstall exactness both compare names, never whole objects.
export async function listRegexNames(scope = REGEX_SCOPE_CHARACTER) {
    return regexNames(await getRegexes(scope));
}

// ── THE CARD CAN BE RIGHT WHILE THE SCREEN IS WRONG (live 2026-08-24) ───────────────────────────────
// SillyTavern pairs EVERY scoped-script write with a UI refresh (index.js:555 after a save, :599 after a
// delete): saveSettingsDebounced, loadRegexScripts, then reloadCurrentChat "to undo previous markdown".
// loadRegexScripts is module-private, but we do not need it directly — reloadCurrentChat ends in
// getChatResult, which emits CHAT_CHANGED, and the regex extension's own CHAT_CHANGED listener
// (index.js:1606) clears the compile cache and re-renders the list. One exported call, both effects.
//
// We had this for free until the migration and lost it silently: TavernHelper's replaceTavernRegexes ends
// in render_tavern_regexes, which refreshes every message and emits CHAT_CHANGED itself
// (tavern_regex.ts:249). Calling SillyTavern's targeted save instead skipped that, so an uninstall left a
// correct CARD behind a stale SCREEN — the regex list still showing 12 scripts the card no longer had,
// until F5. Nothing was wrong with the write; nothing had told the UI.
//
// ⚠ THIS IS THE CALLER'S LAST STEP, NOT THE WRITE'S. CHAT_CHANGED re-runs the pack's own passes, so
// firing it mid-uninstall would run them against a half-removed pack — registry still claiming a pack
// whose engine has already been cleared. It also wakes TavernHelper's settings watcher, the racer the
// verification exists to catch; after the write has settled that watcher's snapshot is the correct one.
// TavernHelper got the ordering right by accident (a 1000 ms debounce put it after the flow); we do it on
// purpose. Hence: exported, and called once the operation is completely finished.
//
// The reload itself belongs to chat-reload.js, which every writer of rendered content shares: an
// activation that changed regexes AND a layout must reload once, not twice. Call this ONLY when a byte
// actually changed — an unchanged re-apply asking for a reload is the storm this replaced.
export async function refreshRegexUi() {
    saveSettingsDebounced();
    await requestChatReload('[tavern-regex] the regex list changed');
}

// A CHARACTER install, done the way SillyTavern's own editor does it (engine.js / index.js:544): convert
// the pack's shapes, merge them into the card's existing scoped scripts, save the ONE key, then ALLOW the
// card's regexes — an unallowed scoped script is written and inert, which is the silent half of this bug.
async function syncCharacterRegexesTheSillyTavernWay(incoming, removeNames, { declaredOrder } = {}) {
    const ctx = typeof getContext === 'function' ? getContext() : null;
    const character = ctx && ctx.characters ? ctx.characters[ctx.characterId] : null;
    if (!character) {
        log.warn('no character open — ' + (Array.isArray(incoming) ? incoming.length : 0) + ' regex(es) NOT written');
        return null;
    }
    const converted = (Array.isArray(incoming) ? incoming : []).map((r) => {
        const st = toSillyTavernRegex(r, regex_placement);
        return st.id ? st : { ...st, id: newRegexId() };
    });
    const current = getScriptsByType(SCRIPT_TYPES.SCOPED, { allowedOnly: false });
    const res = mergeScopedScripts(current, converted, removeNames, () => newRegexId(), { declaredOrder });
    // Nothing differs from what the card already holds → no write, and the caller sees 0/0/0 and skips
    // the reload. A re-apply of an unchanged artifact (every dev-loop connect) is exactly this case.
    // A pure REORDER (W9) is a write — the list changed even though no field did — and it terminates
    // for the same reason the unchanged case exists: the write makes declared == card, so the next
    // apply's merge counts zero and asks for nothing.
    const unchanged = !res.created && !res.updated && !res.removed && !res.reordered;
    if (!unchanged) await saveScriptsByType(res.list, SCRIPT_TYPES.SCOPED);
    // engine.js:175 — pushes the avatar onto character_allowed_regex and saves settings, but ONLY when it
    // is not already there, so calling it on every install is free and never re-saves for nothing.
    allowScopedScripts(character);
    return { created: res.created, updated: res.updated, removed: res.removed, reordered: res.reordered, droppedNames: [], unchanged };
}

// Of the regexes this pack ships, which are ALREADY on the card byte for byte under the same name?
// The §11 adoption read: a card built outside mvu-helper carries the pack's own regexes with no registry
// recording them, and one whose bytes match is one this pack would have written anyway.
//
// Converts through the SAME toSillyTavernRegex the install uses and compares with the SAME rule the write
// counts an update by (scopedScriptUnchanged) — a second, nearly-identical comparison here is how an
// adoption check ends up claiming a regex the user wrote.
//
// Returns [] when nothing matches, and null when the card cannot be read — "could not look" must never
// read as "nothing is adoptable", which would send an adoptable card to the conflict dialog forever.
export async function unchangedCharacterRegexNames(incoming) {
    const ctx = typeof getContext === 'function' ? getContext() : null;
    const character = ctx && ctx.characters ? ctx.characters[ctx.characterId] : null;
    if (!character) {
        log.warn('no character open — cannot tell which regexes the card already matches');
        return null;
    }
    try {
        const converted = (Array.isArray(incoming) ? incoming : []).map((r) => toSillyTavernRegex(r, regex_placement));
        return unchangedScopedNames(getScriptsByType(SCRIPT_TYPES.SCOPED, { allowedOnly: false }), converted);
    } catch (e) {
        log.warn('reading the card\'s scoped scripts failed — cannot tell which regexes match:', e);
        return null;
    }
}

// An artifact install in ONE host write: remove the names a previous version left behind that this one no
// longer ships, and create-or-update everything it does. See syncRegexesInList for why the two halves may
// not be separate calls (one chat reload each, and a window where the card has neither set).
// Returns { created, updated, removed, droppedNames } or null when the API is unavailable / the write throws.
export async function syncRegexes(scope, incoming, removeNames, { declaredOrder } = {}) {
    if (scope === REGEX_SCOPE_CHARACTER) {
        let out;
        try {
            out = await syncCharacterRegexesTheSillyTavernWay(incoming, removeNames, { declaredOrder });
        } catch (e) {
            log.error('the character regex save threw — NO regex was written:', e);
            return null;
        }
        if (!out) return null;
        if (out.unchanged) {
            log.lifecycle('character regexes UNCHANGED — ' + (Array.isArray(incoming) ? incoming.length : 0)
                + ' already on the card byte for byte; no write, no chat reload');
        } else {
            log.lifecycle('character regexes saved the SillyTavern way — ' + out.created + ' created, '
                + out.updated + ' updated, ' + out.removed + ' removed · card allowed to run its own regexes');
        }
        const names = (Array.isArray(incoming) ? incoming : []).map((r) => String((r && r.script_name) || '')).filter(Boolean);
        const v = await verifyAndRepairCharacterWrite(names, VERIFY_INSTALL);
        if (v.offenders.length) return null;   // the caller's contract for "not written" — reported, never claimed
        return out;
    }
    const update = resolveRegexFn('updateTavernRegexesWith');
    if (typeof update !== 'function') {
        log.warn('updateTavernRegexesWith API unavailable — ' + (Array.isArray(incoming) ? incoming.length : 0) + ' regex(es) NOT written');
        return null;
    }
    let out = { created: 0, updated: 0, removed: 0, droppedNames: [] };
    try {
        await update((list) => {
            const res = syncRegexesInList(list, incoming, removeNames, () => newRegexId());
            out = { created: res.created, updated: res.updated, removed: res.removed, droppedNames: res.droppedNames };
            return res.list;
        }, { type: scope });
        log.lifecycle('' + scope + ' regexes synced — ' + out.created + ' created, ' + out.updated + ' updated'
            + (out.removed ? ', ' + out.removed + ' removed (' + out.droppedNames.join(', ') + ')' : ', 0 removed'));
        return out;
    } catch (e) {
        log.error('syncRegexes(' + scope + ') failed — NO regex was written:', e);
        return null;
    }
}

// A CHARACTER uninstall, the same way SillyTavern's own editor removes a scoped script (index.js:577):
// take the card's scoped list, drop the named entries, save the ONE key. mergeScopedScripts with nothing
// incoming IS the removal — every name in removeNames that is not also being re-added gets dropped — so
// install and uninstall share one merge and cannot come to disagree about what "by name" means.
async function removeCharacterRegexesTheSillyTavernWay(wanted) {
    const current = getScriptsByType(SCRIPT_TYPES.SCOPED, { allowedOnly: false });
    const res = mergeScopedScripts(current, [], wanted, () => newRegexId());
    if (!res.removed) return 0;          // none of them are on the card: no write to make, nothing to verify
    try {
        await saveScriptsByType(res.list, SCRIPT_TYPES.SCOPED);
    } catch (e) {
        log.error('the character regex removal threw — ' + wanted.length + ' regex(es) NOT removed:', e);
        return 0;
    }
    log.lifecycle('removed ' + res.removed + ' character regex(es) the SillyTavern way: ' + wanted.join(', '));
    // The same racer can roll a REMOVAL back, and a resurrected regex is worse than one that never
    // installed: it belongs to a pack version that no longer exists, so nothing will ever remove it again.
    const v = await verifyAndRepairCharacterWrite(wanted, VERIFY_REMOVAL);
    // Under-report rather than over-report. The error above names exactly what survived; claiming a count
    // here that the card does not back up is how a green uninstall hides a card still running our regexes.
    if (v.offenders.length) return 0;
    return res.removed;
}

// Remove every regex whose name is in `names`, in ONE host call. Returns the count removed; 0 when the API
// is unavailable (logged), none matched, or the removal could not be made to stick (logged).
export async function deleteRegexesByName(scope, names) {
    const wanted = (Array.isArray(names) ? names : []).map(String).filter(Boolean);
    if (!wanted.length) return 0;
    if (scope === REGEX_SCOPE_CHARACTER) return removeCharacterRegexesTheSillyTavernWay(wanted);
    const update = resolveRegexFn('updateTavernRegexesWith');
    if (typeof update !== 'function') {
        log.warn('updateTavernRegexesWith API unavailable — ' + wanted.length + ' regex(es) NOT removed');
        return 0;
    }
    let removed = 0;
    try {
        await update((list) => {
            const res = removeRegexesByName(list, wanted);
            removed = res.removed;
            return res.list;
        }, { type: scope });
        if (removed) log.lifecycle('removed ' + removed + ' ' + scope + ' regex(es): ' + wanted.join(', '));
        return removed;
    } catch (e) {
        log.warn('deleteRegexesByName(' + scope + ') failed:', e);
        return 0;
    }
}
