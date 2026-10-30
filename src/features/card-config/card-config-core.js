// card-config/card-config-core.js — PURE whole-config logic for the [Initmvuhelper] card carry.
//
// A card ships its whole mvu-helper setup in one lorebook entry, mirroring MVU's [InitVar], so an
// author hands over a card and it works. This file owns the WHOLE-CONFIG passes — parse, normalize,
// serialize, the fingerprint and the import decision, install, merge — and knows nothing about any
// individual feature: each section's shape comes from the registry (card-config-sections.js). Adding a
// section touches the registry, never this file. The I/O glue (lorebook read/write, the profile) is
// card-config.js.
//
// Host-free, so it is unit-tested directly (tests/card-config-core.test.js).

import { unknownKeysOf } from '../../shared/unknown-keys.js';
import { hash36 } from '../../shared/string-hash.js';
import { CARD_CONFIG_SECTIONS, KNOWN_TOP_LEVEL } from './card-config-sections.js';

// Schema version of the [Initmvuhelper] config. Export writes it; normalize reads the card's declared
// version (missing/junk → 1) so a future load can branch or migrate.
//
// WHEN TO BUMP — the policy, stated so the first ambiguous case does not get a defensive bump that
// makes every existing card trigger the newer-schema warn for nothing:
//   BUMP     — the SHAPE of an existing section changes (a field's meaning/type changes, a required
//              field appears, a section is restructured).
//   DO NOT   — adding a whole new top-level section (unknown keys are ignored, so old extensions
//              degrade gracefully on their own), or adding an OPTIONAL field to a section (absent
//              ⇒ default). See plans/executed/card-config-sections-plan.md §6.1.
export const CONFIG_SCHEMA_VERSION = 1;

// Strip MVU-style wrappers and parse the JSON body. Throws on malformed JSON (caller logs + skips).
export function parseInitmvuhelper(content) {
    let s = String(content == null ? '' : content).trim();
    const wrap = s.match(/<initmvuhelper>\s*([\s\S]*?)\s*<\/initmvuhelper>/i);   // like MVU's <initvar> wrapper
    if (wrap) s = wrap[1].trim();
    const fence = s.match(/```[a-z0-9]*\s*\n?([\s\S]*?)\n?```/i);                 // like MVU's ``` fence strip
    if (fence) s = fence[1].trim();
    return normalizeCardConfig(JSON.parse(s));                                   // JSON.parse throws → caller catches
}

// Raw card JSON → { version, <each section>, retired, unknown, blocked }. Sections land at their own
// top-level key (same name as the per-card PROFILE key), so a caller reads cfg.extraLlmCalls directly.
//
// THE THREE REPORT ARRAYS exist for one reason: the card AUTHOR is the only person who can fix what a
// card carries, and a setting dropped in silence gives them nothing to search for. They are separate
// because each needs a DIFFERENT fix:
//   retired  we used to honour this field         → remove it from the card
//   unknown  we never did                         → a typo, or a section from a newer mvu-helper
//   blocked  we understood it and refused it      → it points at the local machine, or the value was
//                                                    the wrong type; set it in the extension instead
export function normalizeCardConfig(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const report = { retired: [], unknown: [], blocked: [] };
    // The card's DECLARED schema version (missing/junk → 1, the earliest). Preserved in the output so the
    // importer can detect a config NEWER than it understands, or a future version can migrate an older one.
    const version = (Number.isInteger(Number(src.version)) && Number(src.version) >= 1) ? Number(src.version) : 1;
    report.unknown.push(...unknownKeysOf(src, KNOWN_TOP_LEVEL, ''));
    const out = { version };
    for (const section of CARD_CONFIG_SECTIONS) {
        out[section.key] = section.normalize(src[section.key], report);
    }
    return { ...out, ...report };
}

// EXPORT — the round-trip of parseInitmvuhelper: the active card's profile → the JSON body an
// [Initmvuhelper] entry carries. Each section decides what it may emit; never-travels fields are absent
// BY CONSTRUCTION rather than filtered here, so the leak cannot be reintroduced by forgetting a filter
// at this call site. Returns a pretty JSON string. Pure + deterministic.
export function serializeCardConfig(profile) {
    const p = (profile && typeof profile === 'object') ? profile : {};
    const out = { version: CONFIG_SCHEMA_VERSION };     // first key — the entry's schema is obvious at a glance
    for (const section of CARD_CONFIG_SECTIONS) {
        const value = section.serialize(p[section.key]);
        if (value !== undefined) out[section.key] = value;
    }
    return JSON.stringify(out, null, 2);
}

// THE FINGERPRINT of a normalized config: a hash of every section this mvu-helper read from the card,
// without the import's report arrays. The parse drops the entry's comments and whitespace, so editing
// those changes nothing. A change in how this mvu-helper reads the same entry does count: it changes what
// the profile should hold.
export function cardConfigFingerprint(cfg) {
    const c = (cfg && typeof cfg === 'object') ? cfg : {};
    const read = { version: c.version };
    for (const section of CARD_CONFIG_SECTIONS) read[section.key] = c[section.key];
    return hash36(JSON.stringify(read));
}

// The card-owned fields a config carries, as profile paths ('imagegen.promptTemplate', 'statBox').
export function carriedCardOwnedFields(cfg) {
    const c = (cfg && typeof cfg === 'object') ? cfg : {};
    return CARD_CONFIG_SECTIONS.flatMap((s) => s.carriedCardOwnedFields(c[s.key]));
}

// What a profile keeps about the config it last imported (by install, re-import or export): the
// fingerprint, which tells the next chat load whether the card's config changed, and the card-owned
// fields it carried, which tells the next re-import which of them the card has dropped since.
// Returned for the caller to assign — they live at the top of the profile, beside the sections.
export function lastImportOf(cfg) {
    return { importedConfigFingerprint: cardConfigFingerprint(cfg), importedCardOwnedFields: carriedCardOwnedFields(cfg) };
}

// A profile this card has never imported into: no fingerprint, and no section holding anything the card
// would own. Card-seeded fields cannot answer this — the feature defaults fill them on every profile.
// A record Reset just deleted is fresh again, so Reset installs.
export function isFreshProfile(profile) {
    const p = (profile && typeof profile === 'object') ? profile : {};
    if (p.importedConfigFingerprint) return false;
    return CARD_CONFIG_SECTIONS.every((s) => !s.isConfigured(p[s.key]));
}

// INSTALL (a fresh profile) — every section takes what the card carries, card-seeded preferences
// included, over the feature defaults: nothing there is the user's yet. Returns { <sectionKey>: value }
// for the caller to assign — pure, so it never touches the profile.
export function installCardConfigSections(profile, cfg) {
    const p = (profile && typeof profile === 'object') ? profile : {};
    const c = (cfg && typeof cfg === 'object') ? cfg : {};
    const next = {};
    for (const section of CARD_CONFIG_SECTIONS) next[section.key] = section.install(p[section.key], c[section.key]);
    return next;
}

// RE-IMPORT — the "Re-import from card" button, or a chat load that finds the card's config changed.
// MERGE, never replace: card-owned fields are refreshed, calls and groups the profile lacks are added,
// and every connection assignment, user preference and hand-added row is kept.
//
// A card-owned field the profile's last import carried and this config does not is cleared to its
// built-in default — the card dropped it, and a card that drops its template means the shipped one. A
// field the card never carried is not in that list, so a value the user typed there is never cleared.
//
// Returns the new section values, a per-section summary, and one line per section that changed: a merge
// that restored three calls and one that changed nothing must not look the same (log-sanity).
export function mergeCardConfigSections(profile, cfg) {
    const p = (profile && typeof profile === 'object') ? profile : {};
    const c = (cfg && typeof cfg === 'object') ? cfg : {};
    const carried = carriedCardOwnedFields(c);
    const dropped = (Array.isArray(p.importedCardOwnedFields) ? p.importedCardOwnedFields : [])
        .filter((path) => !carried.includes(path));
    const merged = {}, summaries = {}, lines = [];
    for (const section of CARD_CONFIG_SECTIONS) {
        const r = section.merge(p[section.key], c[section.key]);
        let value = r.merged;
        const cleared = dropped.filter((path) => path === section.key || path.startsWith(`${section.key}.`));
        for (const path of cleared) value = section.clearCardOwnedField(value, path);
        merged[section.key] = value;
        summaries[section.key] = r.summary;
        const line = section.describe(r.summary);
        if (line) lines.push(line);
        if (cleared.length) lines.push(`cleared ${cleared.join(', ')} to the built-in default (the card no longer carries it)`);
    }
    return { merged, summaries, lines };
}

// The import decision (pure). Returns:
//   'skip-no-card'  — ST's lobby: no card is open, so there is no config and no profile to touch
//   'skip-none'     — the card has no [Initmvuhelper] entry → touch nothing
//   'install'       — a fresh profile (isFreshProfile) → the card seeds everything it carries
//   'reimport'      — the button was pressed, or the card's config is not the one this profile last imported
//                     (a card or pack upgrade rewrote the entry) → the merge
//   'unchanged'     — this profile already holds the card's config → nothing to do
//   'skip-snapshot' — a chat load read the card's EMBEDDED book because the standalone one is not registered
//                     yet. The snapshot is the card as it was imported, and a pack upgrade rewrites only the
//                     standalone book, so comparing against it would re-import an older config and the next
//                     load would re-import the newer one back. It may install a fresh profile (nothing better
//                     is there yet); everything else waits for a read that reaches the standalone book.
// A profile saved before fingerprints existed has none, so its first load re-imports once.
export function decideCardImport({ force = false, isCardOpen = true, hasEntry, isFresh, isEmbeddedSnapshot = false, importedFingerprint, cardFingerprint }) {
    if (!isCardOpen) return 'skip-no-card';
    if (isEmbeddedSnapshot && !force && !(hasEntry && isFresh)) return 'skip-snapshot';
    if (!hasEntry) return 'skip-none';
    if (isFresh) return 'install';
    if (force || importedFingerprint !== cardFingerprint) return 'reimport';
    return 'unchanged';
}

// THE WHOLE IMPORT, PURE: decide, then install or merge, plus what the profile keeps about this import.
// `cfg` is the parsed card config, or null when the card has no [Initmvuhelper] entry; `isEmbeddedSnapshot`
// says the entries came from the card's embedded book (decideCardImport 'skip-snapshot'); `isCardOpen` is
// false in ST's lobby, where `profile` is null. Returns
//   { decision, cardFingerprint, values, summaries, lines }
// where `values` holds every top-level profile key the caller assigns — the sections, the fingerprint and
// the card-owned list — and is empty when nothing is imported. card-config.js does the writing, logging
// and toasts.
export function planCardImport(profile, cfg, { force = false, isCardOpen = true, isEmbeddedSnapshot = false } = {}) {
    const p = (profile && typeof profile === 'object') ? profile : {};
    const cardFingerprint = cfg ? cardConfigFingerprint(cfg) : '';
    const decision = decideCardImport({
        force, isCardOpen, hasEntry: !!cfg, isFresh: isFreshProfile(p), isEmbeddedSnapshot, importedFingerprint: p.importedConfigFingerprint, cardFingerprint,
    });
    if (decision === 'install') {
        return { decision, cardFingerprint, values: { ...installCardConfigSections(p, cfg), ...lastImportOf(cfg) }, summaries: {}, lines: [] };
    }
    if (decision === 'reimport') {
        const { merged, summaries, lines } = mergeCardConfigSections(p, cfg);
        return { decision, cardFingerprint, values: { ...merged, ...lastImportOf(cfg) }, summaries, lines };
    }
    return { decision, cardFingerprint, values: {}, summaries: {}, lines: [] };
}
