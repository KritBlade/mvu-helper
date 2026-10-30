/**
 * ============================================================================
 * MVU HELPER CENTRAL LOG HELPER  (ported from VectFox core/log.js)
 * ============================================================================
 * One verbosity dimension + orthogonal per-domain deep-dives. Replaces the
 * old ad-hoc mix of `console.log` + scattered debug flags (the per-call
 * `call.debug` checkbox, etc.).
 *
 * Levels are chosen by CALL FREQUENCY, not by topic:
 *   error / warn          — always on, never gated
 *   lifecycle             — O(1)/run major state changes  (verbosity >= 1)
 *   verbose               — per-batch timing               (verbosity >= 2)
 *   trace                 — per-item detail                (verbosity >= 3)
 *   domain(name, level)   — subsystem deep-dive, independent of verbosity
 *
 * Config lives at the GLOBAL settings root (not per-card):
 *   extension_settings['mvu-helper'].debug_verbosity   = 'off'|'lifecycle'|'verbose'|'trace'
 *   extension_settings['mvu-helper'].debug_domain.<name> = true|false
 * Defaults are static (no migration shim): absent → off. Only error/warn print
 * until you raise verbosity or flip a domain toggle.
 *
 * EVERY LINE NAMES ITS SOURCE:  [mvu-helper] [<source>] [<sub-tag>]… message
 *   const log = createModuleLog('logic-engine');      // once, at the top of the file
 *   log.warn('…');                                     // [mvu-helper] [logic-engine] …
 *   log.child('RES').domain('pipeline', 'lifecycle', '…');   // [mvu-helper] [logic-engine] [RES] …
 * `<source>` is the module that prints the line — its feature folder, or its host/shared file name
 * without `-core` — or, for text mvu-helper only RELAYS, who wrote it: `engine:<scope>` (engine code
 * in the Worker) or `card` (a card's own scripts on the page). Tags are STRUCTURE, never typed into
 * a message, so a line cannot carry a wrong or stale one; tests/log-tags.test.js holds every src/
 * file to that.
 * ============================================================================
 */

import { extension_settings } from '../../../../../extensions.js';
import { EXTENSION_NAMESPACE } from './extension-paths.js';

const VERBOSITY_LEVELS = { off: 0, lifecycle: 1, verbose: 2, trace: 3 };

/** Console tag prepended to EVERY line so our messages are instantly spottable.
 *  Passed as its own leading arg (not string-concatenated) so it works regardless
 *  of whether the first message arg is a string, an Error, or an object. */
const TAG = `[${EXTENSION_NAMESPACE}]`;

/** Valid domain keys — must match the `debug_domain.*` settings + any UI toggles.
 *  NB: two domains are read by code that CANNOT import this module, so the toggle is shared but the
 *  gate is inlined at the far end. Both read `extension_settings['mvu-helper'].debug_domain.<name>`
 *  off the ST context directly, and both go silent when this extension is absent:
 *    - `pipeline` — CARD-CARRIED code (the EJS Window-A template + the RES `globalLogic` resolver).
 *    - `imagegen` — the galgame-companion Tavern-Helper script (separate bundle, separate iframe;
 *      its env.js log.image()). The image pipeline SPANS both extensions — we draw + splice the
 *      image, the companion names its scene and files it into galgame's backdrop DB — so one
 *      checkbox lights up both halves. Renaming this key silently unwires the companion. */
export const LOG_DOMAINS = ['imagegen', 'roster', 'smallllm', 'pipeline'];

function getVerbosity() {
    const setting = extension_settings?.[EXTENSION_NAMESPACE]?.debug_verbosity;
    return VERBOSITY_LEVELS[setting] ?? VERBOSITY_LEVELS.off;
}

function getDomain(name) {
    return extension_settings?.[EXTENSION_NAMESPACE]?.debug_domain?.[name] === true;
}

function createTaggedLog(tags) {
    // One string, passed as its own leading arg (not concatenated into the message), so it works
    // whether the first message arg is a string, an Error or an object.
    const prefix = [TAG, ...tags.map((tag) => `[${tag}]`)].join(' ');
    return Object.freeze({
        /**
         * Predicate for guarding EXPENSIVE log-argument construction (loops, big
         * JSON.stringify, preview building). For a plain one-liner just call the
         * level method directly — it self-gates. Example:
         *   if (log.enabled('trace')) { for (...) log.trace(buildPreview(...)); }
         * @param {('lifecycle'|'verbose'|'trace')} level
         */
        enabled: (level) => getVerbosity() >= (VERBOSITY_LEVELS[level] ?? Infinity),
        /** True when the given domain deep-dive toggle is on. */
        domainEnabled: (name) => getDomain(name),
        /** Exceptions, data-integrity violations, blocking config. Always on. */
        error: (...args) => console.error(prefix, ...args),
        /** Recovered-from anomaly (hedge fired, retry succeeded, fallback used). Always on. */
        warn: (...args) => console.warn(prefix, ...args),
        /** O(1)/run major state changes. Gated: verbosity >= lifecycle. */
        lifecycle: (...args) => { if (getVerbosity() >= VERBOSITY_LEVELS.lifecycle) console.log(prefix, ...args); },
        /** Per-batch / per-window timing. NEVER per-item. Gated: verbosity >= verbose. */
        verbose: (...args) => { if (getVerbosity() >= VERBOSITY_LEVELS.verbose) console.log(prefix, ...args); },
        /** Per-item detail (call I/O dumps, previews). Gated: verbosity >= trace. */
        trace: (...args) => { if (getVerbosity() >= VERBOSITY_LEVELS.trace) console.log(prefix, ...args); },
        /**
         * Subsystem deep-dive. Fires only when the matching `debug_domain.<name>`
         * toggle is on, regardless of the verbosity dropdown.
         * @param {string} name  one of LOG_DOMAINS
         * @param {string} level internal level — metadata for future sub-gating; ignored for now
         */
        domain: (name, level, ...args) => {
            if (!getDomain(name)) return;
            console.log(prefix, ...args);
        },
        /** The same logger with one more tag — a stage (`RES`, `PRE`) or a sub-unit of the source. */
        child: (subTag) => createTaggedLog([...tags, String(subTag)]),
    });
}

/**
 * The logger for one source — see the header for what a source is.
 * @param {string} source
 */
export function createModuleLog(source) {
    return createTaggedLog([String(source)]);
}
