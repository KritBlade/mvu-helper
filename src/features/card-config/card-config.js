// card-config/card-config.js — card-carried mvu-helper config ([Initmvuhelper]).
//
// Mirrors MVU's [InitVar]: a card ships its mvu-helper setup (the sections card-config-sections.js
// registers — the Extra LLM calls, the image settings and <pic> contract, the roster and logic-engine
// preferences, the stat box) in a lorebook entry whose COMMENT contains `[initmvuhelper]`. Pure parse /
// serialize / fingerprint / decide / merge logic lives in card-config-core.js (unit-tested), driven by
// the section registry; this file is the I/O glue (lorebook + per-card profile).
// See devdoc/dev-helper.md §5.2.
//
// WHEN IT IMPORTS (card-config-core planCardImport). Every chat load reads the card's entry and compares
// its fingerprint with the one this card's profile stored when it last imported:
//   • a fresh profile                     → INSTALL: the card seeds everything it carries
//   • another config (a card or pack upgrade rewrote the entry) → RE-IMPORT, the same merge the button runs
//   • the same config                     → nothing
// Only a read of the standalone book can re-import: during chat load the read may fall back to the card's
// embedded snapshot, which a pack upgrade never rewrites (decideCardImport 'skip-snapshot').
// The profile is per card and shared by every chat of that card, so one import serves all its saves.

import {
    parseInitmvuhelper, serializeCardConfig, planCardImport, lastImportOf, carriedCardOwnedFields, CONFIG_SCHEMA_VERSION,
} from './card-config-core.js';
import { getProfile, saveSettingsDebounced, resetProfile, resetAllProfiles, profileCount } from '../../sillytavern/settings-store.js';
import { confirmPopup } from '../../sillytavern/popup.js';
import { hasActiveCharacter, readPrimaryLorebookEntries, upsertLorebookEntry } from '../../sillytavern/lorebook.js';
import { toast } from '../../sillytavern/mvu-bridge.js';
import { createModuleLog } from '../../sillytavern/log.js';

const log = createModuleLog('card-config');

const ENTRY_MATCH = '[initmvuhelper]';                      // comment substring we locate (case-insensitive)
const ENTRY_COMMENT = '[Initmvuhelper] mvu-helper card config';

// Wrap the JSON body for the lorebook entry. Header comments live OUTSIDE the <initmvuhelper> wrapper so the
// inner text parseInitmvuhelper extracts is pure JSON (JSON.parse rejects # comments); the wrapper is stripped
// on import, exactly like MVU strips <initvar>.
const wrapEntry = (body) =>
    `# mvu-helper card config — imported the first time the card is opened, and again whenever this entry\n` +
    `# changes: the card's own settings are refreshed, each player's preferences are kept.\n` +
    `# The small-LLM CONNECTION is intentionally NOT carried (it's a local per-user profile) — assign it per call\n` +
    `# in the extension's "Extra LLM Calls" tab. Edit config via the GUI, then re-export from the Main tab.\n` +
    `<initmvuhelper>\n${body}\n</initmvuhelper>`;

function findInitEntry(entries) {
    return (Array.isArray(entries) ? entries : []).find((e) => String(e.comment || '').toLowerCase().includes(ENTRY_MATCH)) || null;
}

// Everything in the card this mvu-helper did not import, named in the console. Console-only by design:
// the CARD AUTHOR is the one who set it and the one who can fix it, and a player who cannot change the
// card would only read a toast as breakage. Silence is the thing to avoid — an author who sets a field,
// sees no effect, and finds nothing in the log has no thread to pull. The one toast is the newer-schema
// one: that fix is the player's (update the extension).
function reportSettingsNotImported(cfg) {
    // Version gate: the card declares a schema version. If it's NEWER than we support, a section's shape may
    // differ — import best-effort but warn so the user updates the extension (we never hard-fail on it).
    if (cfg.version > CONFIG_SCHEMA_VERSION) {
        log.warn(`card config is schema v${cfg.version} but this extension supports v${CONFIG_SCHEMA_VERSION} — importing best-effort; update mvu-helper for full support.`);
        toast('warning', `This card's config is a newer format (v${cfg.version}). Update MVU Helper for full support.`);
    }
    // Retired fields the card still carries — a per-call field ({call, field}) or a section field ({path}).
    for (const r of (cfg.retired || [])) {
        const where = r.path ? `"${r.path}"` : `call "${r.call}": the "${r.field}" field`;
        log.warn(`${where} is no longer honoured and was IGNORED — ${r.why}.`);
    }
    // Anything the importer does not recognise. The two causes need DIFFERENT fixes, and `version` is what
    // tells them apart — a card declaring a schema NEWER than we support is probably using a section from a
    // later mvu-helper (update the extension); otherwise it is almost certainly a typo or a hand-edit (fix
    // the card).
    if ((cfg.unknown || []).length) {
        const paths = cfg.unknown.map((u) => u.path).join(', ');
        const cause = cfg.version > CONFIG_SCHEMA_VERSION
            ? `this card declares schema v${cfg.version} and this mvu-helper supports v${CONFIG_SCHEMA_VERSION}, so these are probably from a NEWER version — update mvu-helper`
            : `this mvu-helper has no such setting — check for a typo, or a section that belongs to a different/newer version`;
        log.warn(`IGNORED ${cfg.unknown.length} unrecognised setting(s): ${paths}. Nothing was imported for them (${cause}).`);
    }
    // Settings we DID understand and refused anyway: they point at something on the local machine (a
    // connection UUID, a preset id, a debug switch) or the value was the wrong type. Distinct from `unknown`
    // because the fix is distinct — there is nothing to correct in the card except deleting the field, and
    // the real setting lives in the extension's own GUI.
    for (const b of (cfg.blocked || [])) {
        log.warn(`"${b.path}" was NOT imported — ${b.why}.`);
    }
}

// The one lifecycle line an import writes: its trigger and what it changed. A merge that restored three
// calls and one that changed nothing must not look identical (log-sanity).
function logInstall(cfg, trigger) {
    const owned = carriedCardOwnedFields(cfg);
    log.lifecycle(`install from card (${trigger}) — ${cfg.extraLlmCalls.calls.length} call(s); card-owned fields: ${owned.length ? owned.join(', ') : 'none'}`);
}
function logReimport(summary, lines, trigger) {
    const parts = [];
    if (summary.added.length) parts.push(`added ${summary.added.length} call(s): ${summary.added.join(', ')}`);
    if (summary.updated.length) parts.push(`refreshed ${summary.updated.length}: ${summary.updated.join('; ')}`);
    if (summary.kept.length) parts.push(`left ${summary.kept.length} hand-added untouched: ${summary.kept.join(', ')}`);
    if (summary.deleted && summary.deleted.length) parts.push(`deleted from ${summary.deleted.length} call(s), no longer used: ${summary.deleted.join('; ')}`);
    if (summary.groupsAdded.length) parts.push(`added group(s): ${summary.groupsAdded.join(', ')}`);
    if (summary.groupsUpdated.length) parts.push(`refreshed group member(s): ${summary.groupsUpdated.join(', ')}`);
    parts.push(...lines);                                       // one line per OTHER section that changed something
    log.lifecycle(`re-import from card (${trigger}) — ${parts.length ? parts.join(' · ') : 'nothing to change (profile already matches the card)'}`);
}

// IMPORT — runs on every chat load; {force:true} is the "Re-import from card" button. What happens is
// decided in card-config-core planCardImport (skip-no-card / skip-snapshot / skip-none / install / reimport /
// unchanged); this writes the plan into the profile, logs it and toasts. Returns the decision, or 'error'.
// `isSeedChanged`: the button's seed pass, run just before, changed this chat's state — so a re-import that changed no
// setting does not report "Nothing to restore".
// The no-op decisions log at verbose: the initial-load retry repeats them several times per page load.
export async function importCardConfig({ force = false, isSeedChanged = false } = {}) {
    try {
        // In ST's lobby there is no card: nothing is read, and no profile is created for the lobby.
        const isCardOpen = hasActiveCharacter();
        let read = { entries: [], isEmbeddedSnapshot: false };
        let cfg = null;
        let profile = null;
        if (isCardOpen) {
            read = await readPrimaryLorebookEntries();
            const entry = findInitEntry(read.entries);
            if (entry) {
                try { cfg = parseInitmvuhelper(entry.content); }
                catch (e) { log.error('parse failed — skipping import:', e); toast('error', '[Initmvuhelper] is not valid JSON — see console.'); return 'error'; }
            }
            profile = getProfile();
        }
        const importedFingerprint = profile ? profile.importedConfigFingerprint : undefined;
        const plan = planCardImport(profile, cfg, { force, isCardOpen, isEmbeddedSnapshot: read.isEmbeddedSnapshot });
        const decision = plan.decision;

        if (decision === 'skip-no-card') {
            if (force) toast('warning', 'No card is open — open the card whose config you want to import.');
            else log.verbose('no card is open — nothing to import');
            return decision;
        }
        if (decision === 'skip-snapshot') {
            log.verbose('the standalone lorebook is not registered yet, so only the card\'s embedded snapshot could be read — '
                + 'the config is compared once the standalone book answers');
            return decision;
        }
        if (decision === 'skip-none') {
            if (force) toast('warning', 'No [Initmvuhelper] entry on this card to import.');
            else log.verbose('this card has no [Initmvuhelper] entry — nothing to import');
            return decision;
        }
        if (decision === 'unchanged') {
            log.lifecycle(`card config ${plan.cardFingerprint} is the one this card last imported — nothing to import`);
            return decision;
        }
        reportSettingsNotImported(cfg);
        for (const [key, value] of Object.entries(plan.values)) profile[key] = value;
        saveSettingsDebounced();
        const trigger = force ? 'Re-import from card'
            : decision === 'install' ? 'first load of this card'
                : importedFingerprint ? `the card's config changed: ${importedFingerprint} → ${plan.cardFingerprint}`
                    : `this profile predates import fingerprints; the card's config is ${plan.cardFingerprint}`;

        if (decision === 'install') {
            logInstall(cfg, trigger);
            if (force) toast('success', `Imported ${cfg.extraLlmCalls.calls.length} call(s) from the card. Assign each call's connection in Extra LLM Calls.`);
            return decision;
        }

        // RE-IMPORT — MERGE, never replace (user decision 2026-08-04): card-owned fields are refreshed,
        // missing calls and groups are added, and every connection assignment, preference and hand-added
        // call is kept. See the registry for who owns what.
        const s = plan.summaries.extraLlmCalls;
        logReimport(s, plan.lines, trigger);
        if (!force) {
            // The automatic re-import changes nothing the player must act on, except a call it added: that
            // call has no connection until the player assigns one.
            if (s.added.length) toast('info', `This card's config changed and added ${s.added.join(', ')}. Assign a connection for each in Extra LLM Calls.`);
            return decision;
        }
        if (s.added.length || s.updated.length || s.groupsAdded.length || s.groupsUpdated.length || plan.lines.length) {
            const bits = [];
            if (s.added.length) bits.push(`restored ${s.added.join(', ')}`);
            if (s.updated.length) bits.push(`refreshed ${s.updated.length} from the card`);
            if (s.groupsAdded.length || s.groupsUpdated.length) bits.push('updated shared groups');
            if (plan.lines.length) bits.push('refreshed other card settings (listed in the console)');
            // Name the connection cost ONLY for calls that actually need one — a restored call has
            // no profileId, an untouched one kept its own.
            toast('success', `${bits.join(' · ')}.${s.added.length ? ` Assign a connection for: ${s.added.join(', ')}.` : ''} Existing connections were kept.`);
        } else if (!isSeedChanged) {
            toast('info', 'Nothing to restore — your setup already matches the card.');
        }
        return decision;
    } catch (e) {
        log.error('card-config import failed (non-fatal):', e);
        return 'error';
    }
}

// RESET — the Main-tab button. Discard the stored setup and take the card's again.
//
// WHY IT CLEARS AND IMPORTS IN ONE ACTION. Clearing alone leaves the user staring at a blank profile until
// the next chat load imports the card again; one press is the whole round trip: forget what was stored,
// read what the card actually declares.
//
// WHY IT INSTALLS, NOT the merge the Re-import button runs. Re-import is the SAFE button — it restores
// what is missing and keeps every connection assignment and preference. This is the UNSAFE one, and it
// has to be, because the thing it exists to fix is a stored value that is WRONG and that merge would
// preserve. Deleting the record first makes the profile fresh, so the import installs: every section
// takes the card's values, preferences included, and nothing stale can survive. The confirm dialog
// names that cost.
//
// ALL-CARDS is deliberately a separate call with its own confirmation: it is the only cure for a
// platform default that changed under an existing install (see settings-store.js resetProfile), and
// it is also the one action here that touches cards the user is not looking at.
export async function resetCardConfig({ allCards = false } = {}) {
    try {
        if (allCards) {
            const count = profileCount();
            if (!count) { toast('info', 'No card settings stored — nothing to reset.'); return 'skip-none'; }
            const ok = await confirmPopup([
                { text: 'Reset the settings of every card?' },
                { text: 'Cards with stored settings:', name: String(count) },
                { text: "Lost: every card's Extra LLM Calls, groups, connections and image settings." },
                { text: 'A card with an [Initmvuhelper] entry imports its own setup again when opened; anything else is gone.' },
                { text: 'Global settings stay: resolution presets, prefix presets, logging.' },
            ], { okButton: 'Reset every card', isDestructive: true });
            if (!ok) return 'cancelled';
            const keys = resetAllProfiles();
            log.lifecycle(`reset ALL card profiles (${keys.length}): ${keys.join(', ')}`);
            toast('success', `Reset ${keys.length} card profile(s). Re-open each card (or press "Reset from card") to pull its config.`);
            // The active card is one of them — take its config back immediately so the panel is not blank.
            const decision = await importCardConfig({ force: true });
            return decision === 'skip-none' ? 'reset' : decision;
        }

        const ok = await confirmPopup([
            { text: "Reset this card's settings and import them from the card again?" },
            { text: 'Lost: its Extra LLM Calls, groups and connections. A card never carries connections.' },
            { text: 'Whatever its [Initmvuhelper] entry declares is imported fresh.' },
            { text: 'To bring back only what is missing, use Re-import from card instead.' },
        ], { okButton: 'Reset', isDestructive: true });
        if (!ok) return 'cancelled';
        const key = resetProfile();
        log.lifecycle(`reset the active card profile${key ? ` (${key})` : ' (none was stored)'} — importing from the card`);
        const decision = await importCardConfig({ force: true });
        if (decision === 'skip-none') toast('info', 'Settings reset. This card carries no [Initmvuhelper] entry, so nothing was imported.');
        return decision === 'skip-none' ? 'reset' : decision;
    } catch (e) {
        log.error('reset card config failed:', e);
        toast('error', 'Reset failed — see console.');
        return 'error';
    }
}

// EXPORT — the Main-tab button: serialize the active card's profile into the [Initmvuhelper] entry (create or
// update). Connection profiles are dropped (local). Returns true on success.
export async function exportCardConfig() {
    try {
        const profile = getProfile();
        const body = serializeCardConfig(profile);
        const res = await upsertLorebookEntry(ENTRY_MATCH, ENTRY_COMMENT, wrapEntry(body));
        if (!res) { toast('error', 'No character lorebook to export into (attach a lorebook to the card first).'); return false; }
        // The entry now holds this profile's own config, so the next chat load must not re-import it.
        Object.assign(profile, lastImportOf(parseInitmvuhelper(body)));
        saveSettingsDebounced();
        toast('success', `Config ${res.created ? 'exported to a new' : 'updated in the'} [Initmvuhelper] entry in "${res.book}".`);
        log.lifecycle(`exported config to lorebook "${res.book}" (${res.created ? 'created' : 'updated'}), fingerprint ${profile.importedConfigFingerprint}`);
        return true;
    } catch (e) {
        log.error('export card config failed:', e);
        toast('error', 'Export failed — see console.');
        return false;
    }
}
