// pack-info/pack-info-core.js — PURE shaping for the all-artifact install report.
//
// FOUR packTypes share one library book and one card, but not one registry shape: gamelogic and
// statusmenu each record ONE active artifact, plugin records an ARRAY, and event-pack a MAP. This file
// flattens all four onto ONE row shape, so "what is installed on this card?" has one answer instead of
// four per-tab readings, and computes the disagreements between what a card says it has and what the
// library still holds.
//
// Pure: every read is done by the caller and handed in. No host, no globals.

import { ARTIFACT_ROLES, ARTIFACT_TYPES, pluginFlavorSummary } from '../../shared/card-artifact-store.js';

const str = (v) => String(v == null ? '' : v);

// One packType's parsed registry → the shared row shape. The per-type fields that have no counterpart
// elsewhere ride in `detail`, so a caller can stay generic and still reach them.
//
// `parsed` is that type's own parser output (parsePackRegistry / parseMenuRegistry /
// parsePluginRegistry / event-pack's registry map), or null when there is no registry to read.
export function normalizeInstalledRecords(packType, parsed) {
    if (!parsed || typeof parsed !== 'object') return [];
    if (packType === 'gamelogic') {
        return [{
            id: str(parsed.activePackId), version: str(parsed.ver), name: str(parsed.name),
            entryCount: (parsed.installedComments || []).length,
            detail: {
                engineOwned: parsed.engineOwned === true, schemaOwned: parsed.schemaOwned === true,
                exposes: parsed.exposes || {}, stateVersion: str(parsed.stateVersion),
                regexCount: (parsed.installedRegexNames || []).length, installedAt: str(parsed.installedAt),
            },
        }];
    }
    if (packType === 'statusmenu') {
        return [{
            id: str(parsed.activeMenuId), version: str(parsed.ver), name: str(parsed.name),
            entryCount: (parsed.installedComments || []).length,
            detail: {
                engineOwned: parsed.engineOwned === true, shellOwned: parsed.shellOwned === true,
                regexCount: (parsed.installedRegexNames || []).length,
                targetsPackId: str(parsed.targetsPackId), installedAt: str(parsed.installedAt),
            },
        }];
    }
    if (packType === 'plugin') {
        return (parsed.activePlugins || []).map((p) => ({
            id: str(p.id), version: str(p.ver), name: str(p.name),
            entryCount: (p.installedComments || []).length,
            detail: {
                stateName: str(p.stateName), boundCalls: p.boundCalls || {},
                flavor: pluginFlavorSummary(p).flavor,
                requires: p.requires || [], optionalUses: p.optionalUses || [],
            },
        }));
    }
    if (packType === 'eventpack') {
        // The map registry: { <packId>: { ver } }. Row COUNTS come from the entry, which only the
        // event-pack reporter parses — left to the detail block rather than guessed at here.
        return Object.keys(parsed).map((id) => ({
            id, version: str((parsed[id] || {}).ver), name: '', entryCount: 0, detail: {},
        }));
    }
    return [];
}

/**
 * The whole report. Inputs (all supplied by the caller):
 *   boundWorld        — the card's linked standalone worldbook name, '' when none
 *   worldbookReadable — whether that book could be read at all
 *   byType            — { <packType>: { state, problem, parsed } }; state is
 *                       'ok' | 'missing' (no registry entry) | 'malformed' | 'unreadable'
 *   library           — listLibraryPacks() rows PLUS listStoredEventPacks() rows, or null when the
 *                       library book itself could not be read
 *   eventPackDetail   — the event-pack reporter's richer per-row output, or null
 */
export function buildAllPackInfo({ boundWorld = '', worldbookReadable = false, byType = {}, library = null, eventPackDetail = null } = {}) {
    const libraryRows = (library || []).map((r) => ({
        packType: str(r.packType), id: str(r.id), name: str(r.name),
        version: str(r.version), parseError: str(r.parseError), onThisCard: false,
    }));
    const libraryKey = (t, id) => t + '/' + id;
    const libraryByKey = new Map(libraryRows.map((r) => [libraryKey(r.packType, r.id), r]));

    const disagreements = [];
    const types = {};
    for (const packType of ARTIFACT_TYPES) {
        const role = ARTIFACT_ROLES[packType] || {};
        const slot = byType[packType] || { state: 'unreadable', problem: '', parsed: null };
        const installed = normalizeInstalledRecords(packType, slot.parsed).filter((r) => r.id);
        for (const row of installed) {
            const stored = libraryByKey.get(libraryKey(packType, row.id)) || null;
            if (stored) stored.onThisCard = true;
            row.inLibrary = library === null ? null : !!stored;
            row.libraryVersion = stored ? stored.version : '';
            // The card copy is the one that RUNS; the library copy is what a rebuild restores from.
            // A mismatch means restoring would silently change what the card does.
            if (stored && stored.version && row.version && stored.version !== row.version) {
                disagreements.push(`${role.label || packType} "${row.id}": installed v${row.version} but the library holds v${stored.version}`);
            }
            if (library !== null && !stored) {
                disagreements.push(`${role.label || packType} "${row.id}": installed on this card but NOT in the library — a card rebuild could not get it back`);
            }
        }
        if (slot.state === 'malformed') {
            disagreements.push(`${role.label || packType}: its registry entry is malformed — ${slot.problem || 'unparseable'}`);
        }
        types[packType] = {
            label: str(role.label) || packType,
            role: str(role.role),
            activeAtOnce: role.activeAtOnce == null ? 'many' : role.activeAtOnce,
            registryState: slot.state,
            problem: str(slot.problem),
            installedCount: installed.length,
            installed,
        };
    }
    for (const r of libraryRows) {
        if (r.parseError) disagreements.push(`library "${r.id}" (${r.packType}): stored file no longer parses — ${r.parseError}`);
    }
    // The event-pack reporter looks deeper than a registry (per-row trigger keys, fired state, the
    // chat's own watermark), so its findings are folded in rather than recomputed here.
    for (const d of ((eventPackDetail && eventPackDetail.disagreements) || [])) disagreements.push(d);

    return {
        source: {
            cardReadFrom: boundWorld
                ? `standalone worldbook "${boundWorld}" (character data.extensions.world)`
                : 'no bound worldbook — nothing on this card is readable',
            boundWorld: str(boundWorld),
            worldbookReadable: !!worldbookReadable,
            warning: 'The card PNG\'s embedded data.character_book is a build-time snapshot and is NOT read here. '
                + 'When a bound world exists ST ignores it, so any version read from it describes only the last card BUILD.',
        },
        types,
        library: { readable: library !== null, packs: libraryRows },
        eventPackDetail,
        disagreements,
    };
}
