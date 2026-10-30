// shared/public-settings-core.js — the settings a card's scripts and an engine may read by name
// (`MvuHelper.settings`), and the ones a card may set. One row per setting; every decision about a read
// or a write is made here. Pure: the engine Worker loads this file too (ENGINE_WORKER_MODULES in
// logic-engine/engine-frame-core.js), so it imports only object-path.js, which imports nothing.
//
// WHY BY NAME. A card that reads `extension_settings['mvu-helper'].debug_domain.pipeline` reaches
// SillyTavern's whole settings object to learn one switch, and a pack whose templates name
// `extensionSettings` is warned about when it is installed (plans/pack-install-warning.md). A row
// names one setting and says where mvu-helper keeps it and what it may hold, so a card asks for
// `debug.pipeline` and nothing else, and the storage can move without breaking a card. A new setting
// is a new row.
//
// WHAT AN UNSET OR INVALID SETTING ANSWERS is what mvu-helper's own reader of it already makes of it —
// sillytavern/log.js reads a debug switch as `=== true` and an unknown verbosity as 'off', and
// sillytavern/i18n.js reads a missing language as 'en' — so this door and those readers never disagree.
//
// Shared: the rows describe settings different parts of mvu-helper own (the Main tab's debug switches,
// the panel's language), and two features read them — the page door (features/public-settings) and
// the engine's snapshot (logic-engine/engine-capability-block.js).

import { getPath, ensurePath } from './object-path.js';

/** The debug domains a card may read and set: sillytavern/log.js LOG_DOMAINS (a test holds the two equal). */
export const PUBLIC_DEBUG_DOMAINS = Object.freeze(['pipeline', 'imagegen', 'roster', 'smallllm']);

const DEBUG_VERBOSITY_LEVELS = Object.freeze(['off', 'lifecycle', 'verbose', 'trace']);

// A row: `name` (what a card asks for), `path` (where it lives under mvu-helper's settings root, dotted),
// `kind` ('switch' — true or false; 'level' — one of `levels`; 'text' — a non-empty string), `unset`
// (what an unset or invalid value answers), `isWritable` (a card may set it) and `isEngineVisible`
// (the engine Worker's snapshot carries it).
const PUBLIC_SETTINGS = Object.freeze([
    Object.freeze({ name: 'debug.verbosity', path: 'debug_verbosity', kind: 'level', levels: DEBUG_VERBOSITY_LEVELS, unset: 'off', isWritable: false, isEngineVisible: true }),
    ...PUBLIC_DEBUG_DOMAINS.map((domain) => Object.freeze({
        name: 'debug.' + domain, path: 'debug_domain.' + domain, kind: 'switch', unset: false, isWritable: true, isEngineVisible: true,
    })),
    Object.freeze({ name: 'language', path: 'language', kind: 'text', unset: 'en', isWritable: false, isEngineVisible: true }),
]);

/** The row named `name`, or null. */
export function publicSettingRow(name) {
    return PUBLIC_SETTINGS.find((row) => row.name === name) || null;
}

/** Every row's name, in table order — what `MvuHelper.settings.names()` lists. */
export function publicSettingNames() {
    return PUBLIC_SETTINGS.map((row) => row.name);
}

function isValidValue(row, value) {
    if (row.kind === 'switch') return typeof value === 'boolean';
    if (row.kind === 'level') return row.levels.includes(value);
    return typeof value === 'string' && value !== '';
}

function describeKind(row) {
    if (row.kind === 'switch') return 'true or false';
    if (row.kind === 'level') return 'one of ' + row.levels.join(', ');
    return 'a non-empty string';
}

/** What `row` answers, read off mvu-helper's settings root (`extension_settings['mvu-helper']`). */
export function readPublicSetting(root, row) {
    const value = getPath(root, row.path);
    if (row.kind === 'switch') return value === true;
    return isValidValue(row, value) ? value : row.unset;
}

/** Why `value` cannot be set into the setting named `name`, as a sentence — or null when it can. */
export function publicSettingWriteProblem(name, value) {
    const row = publicSettingRow(name);
    if (!row) return '"' + name + '" is not a setting — the settings are ' + publicSettingNames().join(', ');
    if (!row.isWritable) return '"' + name + '" can be read but not set';
    if (!isValidValue(row, value)) return '"' + name + '" takes ' + describeKind(row) + ', and was given ' + String(JSON.stringify(value));
    return null;
}

/**
 * Store `value` at `row`'s place under `root`, making the objects on the way; check it first
 * (publicSettingWriteProblem). False, with nothing written, when a value that is not an object stands
 * where an object must go — a hand-edited settings file, never overwritten here.
 */
export function writePublicSetting(root, row, value) {
    const cut = row.path.lastIndexOf('.');
    const container = cut < 0 ? root : ensurePath(root, row.path.slice(0, cut));
    if (!container) return false;
    container[row.path.slice(cut + 1)] = value;
    return true;
}

/** The engine's copy, `{ name: value }` for every engine-visible row: plain data, so it survives a structured clone. */
export function publicSettingsSnapshot(root) {
    const values = {};
    for (const row of PUBLIC_SETTINGS) {
        if (row.isEngineVisible) values[row.name] = readPublicSetting(root, row);
    }
    return values;
}
