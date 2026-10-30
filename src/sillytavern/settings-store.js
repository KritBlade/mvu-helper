// sillytavern/settings-store.js — the single source of truth for where settings live.
//
// Two scopes:
//   • GLOBAL  — MACHINE/APP knobs shared across every card: GPU concurrency, VRAM-bound resolution
//     presets, streaming, the /sd prompt-prefix list, logging.
//   • PROFILE — CARD BEHAVIOR, stored PER character card, because mvu-helper is generic:
//     Extra LLM Calls (extraLlmCalls: enabled/parallel/timeoutSec/groups/calls), image-gen behavior (imagegen: the
//     <pic> contract, insertType, maxImagesPerReply, …) and the roster's (roster: route, …) — School/Love/RPG
//     each want their own setup. The card's [Initmvuhelper] fills it (features/card-config).
//
// A profile is keyed by `<handleId>_<charName>_<hash>` (user persona + character, plus
// a hash of the raw pair), derived live from SillyTavern.getContext() — so switching
// card/persona switches the active profile with no extra bookkeeping. New cards lazily
// clone the profile template; with no card open nothing is stored (settings-store-core
// profileRecordFor).
//
// index.js is the composition root: it passes each feature's defaults in via
// loadSettings(globalDefaults, profileDefaults); this module stays feature-agnostic.

import { extension_settings } from '../../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../../script.js';
import { EXTENSION_NAMESPACE } from './extension-paths.js';
import { createModuleLog } from './log.js';
import { fillMissingDefaults, profileRecordFor } from './settings-store-core.js';
import { hasActiveCharacter } from './lorebook.js';
import { hash36 } from '../shared/string-hash.js';

const log = createModuleLog('settings-store');

// Stashed from loadSettings() so getProfile() can clone a fresh per-card record.
// Overwritten by loadSettings(); this literal only covers a getProfile() call that beats it. Its values
// MUST match extraLlmCallsDefaults — three spellings of one default disagreed until 2026-08-26 (this
// said enabled:false, the real template said true, and getProfile's repair said false again), so a
// card's Extra LLM Calls default depended on which of the three answered first. Resolved to the
// template's `true` (user).
let _profileDefaults = { extraLlmCalls: { enabled: true, parallel: true, timeoutSec: 60, groups: [], calls: [] } };

function clone(obj) {
    // EXPECTED: structuredClone refuses functions and DOM nodes. Everything cloned here is plain settings
    // data, so the JSON round-trip is an equivalent clone for every value this is actually called with.
    try { return structuredClone(obj); } catch (_e) { return JSON.parse(JSON.stringify(obj)); }
}

// Root settings object (creating it if ST hasn't yet). Image-gen reads/writes here.
export function getGlobal() {
    extension_settings[EXTENSION_NAMESPACE] = extension_settings[EXTENSION_NAMESPACE] || {};
    return extension_settings[EXTENSION_NAMESPACE];
}

// Build the per-card key from the live context (persona name1 + character name2). hash36 is stable
// across reloads, so a given persona+card pair always maps to the same profile.
export function profileKey() {
    try {
        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? SillyTavern.getContext()
            : null;
        const raw1 = String((ctx && ctx.name1) || 'user');
        const raw2 = String((ctx && ctx.name2) || 'chat');
        const norm = (v, fallback) =>
            v.toLowerCase()
                .replace(/[^\p{L}\p{N}]+/gu, '_')
                .replace(/^_|_$/g, '')
                .substring(0, 30) || fallback;
        // Readable prefix (for eyeballing settings.json) + a hash of the FULL, raw name
        // pair so truncation/normalization can never collide two distinct cards. A NUL
        // separator (can't occur in a name) keeps "a b"+"c" from hashing the same as
        // "a"+"b c". CJK/Japanese names are Unicode letters (\p{L}), so norm() KEEPS them
        // — the prefix reads e.g. `albert_春日部つむぎ` (valid as a JSON key), and the hash
        // disambiguates any 30-char truncation.
        const readable = `${norm(raw1, 'user')}_${norm(raw2, 'chat')}`;
        return `${readable}_${hash36(raw1 + String.fromCharCode(0) + raw2)}`;
    } catch (e) {
        log.child('profileKey').warn('could not read SillyTavern context — using fallback key (per-card settings may not resolve):', e);
        return 'user_chat';
    }
}

// The active card's per-profile record, lazily created from the template. With no card open (the
// lobby) a frozen copy of the template that is never stored, so a write to it throws — see
// profileRecordFor. The repairs and the backfill below are no-ops on that copy: it IS the template.
export function getProfile() {
    const root = getGlobal();
    root.profiles = root.profiles || {};
    const key = profileKey();
    const p = profileRecordFor(root.profiles, key, _profileDefaults, { isCardOpen: hasActiveCharacter() });
    // Defensive: repair sub-shapes that are PRESENT but wrong-typed (older/partial records). These run
    // FIRST, before the generic backfill below, and the order is load-bearing — see there.
    if (!p.extraLlmCalls || typeof p.extraLlmCalls !== 'object') p.extraLlmCalls = clone(_profileDefaults.extraLlmCalls);
    if (typeof p.extraLlmCalls.enabled !== 'boolean') p.extraLlmCalls.enabled = _profileDefaults.extraLlmCalls.enabled;
    if (typeof p.extraLlmCalls.parallel !== 'boolean') p.extraLlmCalls.parallel = true;
    if (!Array.isArray(p.extraLlmCalls.groups)) p.extraLlmCalls.groups = [];
    if (!Number.isFinite(p.extraLlmCalls.timeoutSec)) p.extraLlmCalls.timeoutSec = 60;
    if (!Array.isArray(p.extraLlmCalls.calls)) p.extraLlmCalls.calls = [];

    // THE BACKFILL that profile defaults never had (global defaults have always had it, in
    // loadSettings). Without this, a field added to any *ProfileDefaults reaches only profiles created
    // AFTER it shipped — every existing card silently runs with the key absent, which is why four
    // features each hand-wrote a defensive accessor. Now a new field needs none unless it has an enum.
    //
    // The two halves do different jobs and cannot replace each other: the repairs above fix values that
    // are PRESENT but wrong-typed (which this skips, since they are defined), and this fills keys that
    // are ABSENT (which the repairs cannot know about — nothing lists them). Running repairs first is
    // the plain reading; it does not change any answer, now that every repair agrees with the template.
    const filled = fillMissingDefaults(p, _profileDefaults);
    if (filled) log.lifecycle(`backfilled ${filled} missing profile field(s) for "${key}" from the current defaults`);
    return p;
}

// ── reset ────────────────────────────────────────────────────────────────────
// DELETE a profile record rather than overwrite it with the template: getProfile() re-clones lazily,
// so a deleted record is genuinely fresh — no import fingerprint, nothing set up — and the card-config
// import installs into it (card-config-core isFreshProfile). Overwriting with `_profileDefaults` would
// leave whatever fields the template happens to carry, and a template value is indistinguishable from a
// user's choice.
//
// WHY IT EXISTS. A per-card profile is sticky by design: a re-import keeps the user's preferences and
// every value the card does not carry, so a value saved under an older platform default keeps
// overriding the current one indefinitely. Reset drops a card's stored setup whole, and the card's
// config is installed afresh.

/** Forget the ACTIVE card's profile. Returns the key that was removed, or null if there was none. */
export function resetProfile() {
    const root = getGlobal();
    const key = profileKey();
    if (!root.profiles || !root.profiles[key]) return null;
    delete root.profiles[key];
    saveSettingsDebounced();
    return key;
}

/** Forget EVERY card's profile. Returns the keys removed. Global/machine settings are untouched. */
export function resetAllProfiles() {
    const root = getGlobal();
    const keys = Object.keys(root.profiles || {});
    root.profiles = {};
    saveSettingsDebounced();
    return keys;
}

/** How many card profiles exist — so a confirm dialog can say what it is about to discard. */
export function profileCount() {
    return Object.keys(getGlobal().profiles || {}).length;
}

export { saveSettingsDebounced };

// Initialise the store. `globalDefaults` = image-gen fields (live at root);
// `profileDefaults` = the per-card template (cloned per card on demand).
export function loadSettings(globalDefaults, profileDefaults) {
    _profileDefaults = clone(profileDefaults);
    const root = getGlobal();

    // ── GLOBAL defaults (deep-ish merge; never clobber existing values) ──────────
    for (const key of Object.keys(globalDefaults)) {
        const def = globalDefaults[key];
        if (root[key] === undefined) {
            root[key] = clone(def);
        } else if (def && typeof def === 'object' && !Array.isArray(def)) {
            // fill in any missing sub-keys (e.g. a new bustStrength field)
            for (const sub of Object.keys(def)) {
                if (root[key][sub] === undefined) root[key][sub] = clone(def[sub]);
            }
        }
    }

    root.profiles = root.profiles || {};
    return root;
}
