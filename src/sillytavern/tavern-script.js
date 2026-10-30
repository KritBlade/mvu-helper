// sillytavern/tavern-script.js — the ONLY place mvu-helper touches TavernHelper's script API.
//
// TavernHelper SCRIPTS live in three scopes ('global', 'preset', 'character'); a feature reads and writes the
// scripts it owns by exact name — mvu-bootstrap the global `mvu` import, pack activation the card's schema
// script.
//
// API (verified, JS-Slash-Runner @types/function/script.d.ts):
//   getScriptTrees({type})                 → ScriptTree[]
//   updateScriptTreesWith(updater, {type}) → ScriptTree[]   (updater: trees => trees; may be async)
//   replaceScriptTrees(trees, {type})      → wholesale replace — NOT used here; an updater is targeted
// ⚠ The .d.ts DOC COMMENT MISLABELS the scope enum (it writes 'chat'/'global' against the wrong entries).
// The TYPE is authoritative: 'global' | 'preset' | 'character'. Read the type, never that comment.
//
// Every tree DECISION (walking, upsert-by-name, enablement) lives in tavern-script-core.js so it is testable;
// this file is I/O and logging only.

import { createModuleLog } from './log.js';
import {
    findScriptByName,
    upsertScriptInTree,
    removeScriptFromTree,
    setScriptsEnabledById,
} from './tavern-script-core.js';

const log = createModuleLog('tavern-script');

export const SCRIPT_SCOPE_CHARACTER = 'character';
export const SCRIPT_SCOPE_GLOBAL = 'global';

// Same resolution ladder as lorebook.js: bare global → TavernHelper → parent's bare → parent's TavernHelper.
// (Duplicated deliberately rather than shared: lorebook.js's copy is private to it, and exporting one would
// make a host-API detail part of a module's public surface. If a THIRD file needs it, extract it then — P3.)
function resolveScriptFn(name) {
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

// Is the script API attached RIGHT NOW — both halves of it?
//
// Exists because `getScriptTrees` returns [] for two unrelated situations: "this scope has no scripts" and
// "I could not look". Callers that act on the difference (the MVU bootstrap does — see mvu-bootstrap-core.js)
// must be able to ASK, rather than infer absence from an empty array. mvu-helper initialises before
// TavernHelper attaches its API (measured: ~14 s after document start), so at extension load this is false
// and later true.
//
// BOTH functions are required, deliberately. A reader without a writer can tell you MVU is missing and then
// fail to install it — the worst of the two states, because it looks like a decision rather than an outage.
export function isScriptApiAvailable() {
    return typeof resolveScriptFn('getScriptTrees') === 'function'
        && typeof resolveScriptFn('updateScriptTreesWith') === 'function';
}

// A fresh script id. TavernHelper assigns its own ids to scripts it creates; ours only has to be unique and
// stable-looking within the tree. Kept out of the core so the core stays deterministic under test.
function newScriptId() {
    return 'mvuhelper-' + Math.random().toString(36).slice(2, 10);
}

// Read a scope's script trees. [] when the API is unavailable or the read throws (logged, never silent).
export async function getScriptTrees(scope) {
    const getTrees = resolveScriptFn('getScriptTrees');
    if (typeof getTrees !== 'function') {
        log.warn('getScriptTrees API unavailable — cannot read ' + scope + ' scripts');
        return [];
    }
    try {
        const trees = await getTrees({ type: scope });
        return Array.isArray(trees) ? trees : [];
    } catch (e) {
        log.warn('getScriptTrees(' + scope + ') failed:', e);
        return [];
    }
}

// Write (create or update) a script by exact name. `fields` may carry any Script field; `content` is the
// usual one. Update MERGES and keeps the node's id plus any button/data the script already had (see the core).
// Returns { name, created } or null when the API is unavailable / the write throws.
export async function upsertScript(scope, name, fields) {
    const updateTrees = resolveScriptFn('updateScriptTreesWith');
    if (typeof updateTrees !== 'function') {
        log.warn('updateScriptTreesWith API unavailable — "' + name + '" NOT written');
        return null;
    }
    let created = false;
    try {
        await updateTrees((trees) => {
            const res = upsertScriptInTree(trees, { name: String(name || ''), ...(fields || {}) }, newScriptId());
            created = res.created;
            return res.trees;
        }, { type: scope });
        log.lifecycle('' + (created ? 'created' : 'updated') + ' ' + scope + ' script "' + name + '"'
            + ' (' + String((fields && fields.content) || '').length + ' bytes)');
        return { name: String(name || ''), created };
    } catch (e) {
        log.error('upsertScript(' + scope + ', "' + name + '") failed — the script was NOT written:', e);
        return null;
    }
}

// Remove every script with this exact name from a scope. Returns the count removed; 0 when absent or the API
// is unavailable (logged).
export async function deleteScript(scope, name) {
    const updateTrees = resolveScriptFn('updateScriptTreesWith');
    if (typeof updateTrees !== 'function') {
        log.warn('updateScriptTreesWith API unavailable — "' + name + '" NOT removed');
        return 0;
    }
    let removed = 0;
    try {
        await updateTrees((trees) => {
            const res = removeScriptFromTree(trees, name);
            removed = res.removed;
            return res.trees;
        }, { type: scope });
        if (removed) log.lifecycle('removed ' + removed + ' ' + scope + ' script(s) named "' + name + '"');
        return removed;
    } catch (e) {
        log.warn('deleteScript(' + scope + ', "' + name + '") failed:', e);
        return 0;
    }
}

// Set `enabled` on the scripts with these ids in one scope — by id, so exactly the nodes a scan identified
// flip; folders are never touched. Returns the names actually changed ([] when every script was already at
// that value), or null when the API is unavailable or the write throws (logged).
export async function setScriptsEnabled(scope, ids, enabled) {
    const updateTrees = resolveScriptFn('updateScriptTreesWith');
    if (typeof updateTrees !== 'function') {
        log.warn('updateScriptTreesWith API unavailable — ' + scope + ' scripts NOT ' + (enabled ? 'enabled' : 'disabled'));
        return null;
    }
    let changed = [];
    try {
        await updateTrees((trees) => {
            const res = setScriptsEnabledById(trees, ids, enabled);
            changed = res.changed;
            return res.trees;
        }, { type: scope });
        return changed;
    } catch (e) {
        log.error('setScriptsEnabled(' + scope + ', ' + (enabled ? 'on' : 'off') + ') failed — the scripts were NOT changed:', e);
        return null;
    }
}

// Bounce one script by exact name: enabled off, a settle pause, enabled on. TavernHelper renders script
// iframes reactively off the tree (Script.vue keys each <Iframe> on the enabled set), so the off-write
// unmounts the instance and the on-write boots a FRESH one — listeners re-registered. The pause is what
// makes it a bounce: both writes inside one Vue flush would net to "no change" and remount nothing.
// This is the heal for a script whose iframe died or whose listeners were stripped while the page ran.
// Returns true when both writes landed on an existing script; false otherwise (logged, never silent).
export async function bounceScript(scope, name, settleMs = 400) {
    if (!isScriptApiAvailable()) {
        log.warn('the TavernHelper script API is unavailable — cannot bounce "' + name + '"');
        return false;
    }
    const target = findScriptByName(await getScriptTrees(scope), name);
    if (!target) {
        log.child('bounceScript').warn('no ' + scope + ' script named "' + name + '" — nothing to bounce');
        return false;
    }
    if (await setScriptsEnabled(scope, [target.id], false) === null) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.max(50, settleMs)));
    if (await setScriptsEnabled(scope, [target.id], true) === null) {
        log.error('bounceScript(' + scope + ', "' + name + '") left the script OFF — turn it back on in TavernHelper\'s script list');
        return false;
    }
    log.lifecycle('bounced ' + scope + ' script "' + name + '" (off → ' + settleMs + 'ms → on) — fresh instance, listeners re-registered');
    return true;
}
