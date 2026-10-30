// features/mvu-bootstrap/mvu-bootstrap-core.js — every decision the MVU bootstrap makes, pure so it is tested
// and mutation-verified (L6: a gate inside a host-coupled file cannot be tested at all).
//
// UNAVAILABLE IS NOT ABSENT, and it is checked FIRST. mvu-helper initialises before TavernHelper attaches its
// script API, and a detached API reads as an empty script list — the same answer as "MVU is not installed".
// Acting on that answer would offer an install the user already has, write it into nothing, and, worst, record
// a dismissal as a decline: the one outcome that is remembered rather than retried. So while blind the
// bootstrap does nothing at all — no prompt, no write, no record. The load-time check waits for the API
// instead (waitUntilReady); a chat-load check that finds it detached is retried on the next chat load.

import { flattenScriptTreeWithEnablement } from '../../sillytavern/tavern-script-core.js';

// The URL substring that identifies an MVU bundle import, whatever mirror or path spells it. Matched on the
// REPO name rather than a full URL: a different CDN mirror, tag or artifact path is the SAME dependency.
export const MVU_BUNDLE_MARKER = 'MagVarUpdate';

// Every script in the tree that imports an MVU bundle: [{ id, name, url, isEnabled }]. `url` is '' when the
// marker is present but no quoted specifier parses — still worth reporting, since something references MVU
// in a way this scan cannot compare. `isEnabled` is whether TavernHelper RUNS it (script and folder both on).
//
// Disabled imports are REPORTED, not filtered: a disabled script neither provides MVU nor double-loads it,
// but "there is a disabled mvu script here" is exactly what a user needs told when nothing works.
export function findMvuBundleImports(trees) {
    return flattenScriptTreeWithEnablement(trees)
        .filter(({ script }) => String(script.content || '').includes(MVU_BUNDLE_MARKER))
        .map(({ script, isEnabled }) => {
            const m = String(script.content || '').match(/['"]([^'"]*MagVarUpdate[^'"]*)['"]/);
            return { id: String(script.id || ''), name: String(script.name || ''), url: m ? m[1] : '', isEnabled };
        });
}

// Only the imports that actually LOAD — the set that answers "is MVU present?" and "can this double-load?".
export function enabledMvuImports(imports) {
    return (Array.isArray(imports) ? imports : []).filter((i) => i && i.isEnabled === true);
}

// Which card-scoped imports DUPLICATE the global one mvu-helper installs? EVERY enabled one, whatever its url:
// each TavernHelper script runs in its OWN iframe and module maps are per realm, so even the identical url
// boots a second MVU instance. Two instances collide — the survivor's message-parse listener dies and every
// chat's state silently stops updating until a page reload.
export function duplicateCardMvuImports(cardImports) {
    return enabledMvuImports(cardImports);
}

/**
 * What should the bootstrap do right now?
 *
 * @param {object} state
 * @param {boolean} state.isScriptApiAvailable  can we BOTH read and write TavernHelper scripts this instant?
 * @param {Array}  state.enabledImports         global MVU imports that actually load (enabledMvuImports)
 * @param {boolean} state.hasDeclined           the user was asked before and said no
 * @param {boolean} state.isRequestedByUser     the user pressed "Install MVU" — the click is the consent
 * @returns {'unavailable'|'present'|'install'|'declined'|'ask'}
 */
export function decideBootstrapAction({ isScriptApiAvailable, enabledImports, hasDeclined, isRequestedByUser } = {}) {
    // FIRST, and it must stay first: every branch below reads a fact we only have if the API answered. A user's
    // request does not override it — an install against a detached API writes into nothing.
    if (!isScriptApiAvailable) return 'unavailable';

    // Present means RUNNING, not merely written: a disabled script provides nothing.
    if (Array.isArray(enabledImports) && enabledImports.length > 0) return 'present';

    if (isRequestedByUser) return 'install';

    if (hasDeclined) return 'declined';

    return 'ask';
}

/**
 * Poll `isReady` until it answers true or `deadlineMs` has been waited. `sleep` is injected so the loop is
 * tested without real time.
 *
 * @param {() => boolean} isReady
 * @param {{ deadlineMs: number, intervalMs: number, sleep: (ms: number) => Promise<void> }} timing
 * @returns {Promise<boolean>}  true once ready; false when the deadline passed first
 */
export async function waitUntilReady(isReady, { deadlineMs, intervalMs, sleep }) {
    for (let waitedMs = 0; ; waitedMs += intervalMs) {
        if (isReady()) return true;
        if (waitedMs >= deadlineMs) return false;
        await sleep(intervalMs);
    }
}

/**
 * Does the Main tab's "Install MVU" offer show after this bootstrap result?
 *
 * @param {string} result  ensureGlobalMvuImport's return value
 * @returns {'show'|'hide'|'keep'}  'keep' = the result says nothing about MVU (the API was not attached)
 */
export function installOfferAfter(result) {
    if (result === 'present' || result === 'installed') return 'hide';
    if (result === 'declined' || result === 'failed') return 'show';
    return 'keep';
}
