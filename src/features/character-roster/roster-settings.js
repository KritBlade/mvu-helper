// character-roster/roster-settings.js — the roster's PER-CARD settings (PROFILE scope).
//
// Split out of imagegen's profile 2026-07-22, when the roster became its own feature. These keys are
// about THE ROSTER — where it lives in stat_data, how a member is marked present, how new members get
// registered — not about drawing. Drawing (insertType, resolution, strip, latches)
// stays in imagegen's own profile block.
//
// Kept in a SEPARATE file from roster-ui.js on purpose: imagegen/image-gen.js consumes these
// settings (it injects the harvest contract and scans the cast) and must be able to read them
// WITHOUT importing the roster's GUI module. That keeps the dependency graph one-way:
//   imagegen/  →  character-roster/roster-settings.js
// and never the reverse (CLAUDE.md, Directory structure, P5).

import { getProfile } from '../../sillytavern/settings-store.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { rosterProfileOf } from './roster-settings-core.js';

const log = createModuleLog('character-roster');

// This card's roster settings; the template and the repair are roster-settings-core.js.
export function getRosterProfile() {
    return rosterProfileOf(getProfile());
}

// Drawing needs to react when the route flips (refresh the registration-target dropdown, re-point or
// delete the llm-task routing entry). Rather than roster-ui importing imagegen to call those —
// which would make the two folders import each other — imagegen REGISTERS what it wants done.
// Same inversion pattern as llm-task-router's setTaskTargetSource (CLAUDE.md, Directory structure, P5).
const routeChangeListeners = [];

// Register a callback fired after the route setting changes. Called once, at imagegen init.
export function onRouteChange(fn) {
    if (typeof fn === 'function') routeChangeListeners.push(fn);
}

// Fired by roster-ui.js after it writes the new route. A throwing listener must not stop the
// others (or leave the UI half-updated), so each is isolated.
export function notifyRouteChanged() {
    for (const fn of routeChangeListeners) {
        try { fn(); } catch (e) { log.error('a route-change listener failed:', e); }
    }
}
