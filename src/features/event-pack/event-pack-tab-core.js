// event-pack/event-pack-tab-core.js — what the Event Packs tab shows, pure: the words and values its rows and its import
// preview are built from (event-pack-ui.js builds the genes). Fixed words come as { text }, values as { name }; a { text }
// is written first in its object, where the G1 guard reads it as a key zh-cn must hold.

// The four artifact states (shared/card-artifact-store.js deriveArtifactLed) as pills, and for the two a user must act on,
// the line saying what to do. A pack installed before the library existed is amber on purpose: copying it into the
// library behind the user's back is migration logic, which is not written without asking, and a re-import stores it.
const PACK_STATES = {
    green: { pill: { text: 'Installed', status: 'success' } },
    grey: { pill: { text: 'Disabled', status: 'neutral' } },
    red: {
        pill: { text: 'Entry missing', status: 'danger' },
        remedy: { text: 'Its lorebook entry is gone: install it again from the library, or uninstall it.' },
    },
    amber: {
        pill: { text: 'No library copy', status: 'warning' },
        remedy: { text: 'Not in the library: import it again to keep a copy a card rebuild cannot lose.' },
    },
};

/**
 * One installed pack's row, from its packInfo row (event-pack-core.js buildPackInfo — the same read MvuHelper.packInfo
 * reports, so the tab and the diagnostic cannot disagree). A fired count of -1 means the card's engine names no trigger
 * table, so the count is unknown and never shown as 0.
 * Returns { pill, sub, toggle } — toggle is 'disable', 'enable', or '' while the entry is missing.
 */
export function installedPackRowView(row) {
    const { pill, remedy } = PACK_STATES[row.led] || PACK_STATES.red;
    const parts = [{ name: `v${row.version || '?'}` }];
    if (row.events) {
        parts.push({ name: ` · ${row.events} ` }, { text: 'events' }, { name: ' · ' });
        parts.push(...(row.fired < 0 ? [{ text: 'fired state unknown' }] : [{ name: `${row.fired} ` }, { text: 'fired' }]));
    }
    const toggle = !row.entryPresent ? '' : (row.entryEnabled ? 'disable' : 'enable');
    return { pill, sub: remedy ? [{ parts }, remedy] : [{ parts }], toggle };
}

/**
 * One library pack's row, from listStoredEventPacks (event-pack-library.js). A stored file that no longer parses is
 * still listed, so it can be removed, and offers no install. Returns { pills, sub, canInstall }.
 */
export function libraryPackRowView(stored, { isOnThisCard = false } = {}) {
    if (stored.parseError) {
        return { pills: [{ text: 'Does not parse', status: 'danger' }], sub: [{ name: stored.parseError }], canInstall: false };
    }
    return {
        pills: isOnThisCard ? [{ text: 'Installed here', status: 'accent' }] : [],
        sub: [{ parts: [{ name: `v${stored.version || '?'} · ${stored.events} ` }, { text: 'events' }] }],
        canInstall: true,
    };
}

// Every error in an upload file, file-level first, then each pack's tagged with the pack it came from. One list,
// because an install is all-or-nothing: the file lands whole or not at all.
export function fileErrors(result) {
    return result.errors.concat(...result.packs.map((per) => per.errors.map((error) => `${per.pack.packId}: ${error}`)));
}

/**
 * The import preview: a validation result (event-pack-install.js validateUploadFile) as a result list's heading and lines.
 * Each pack, then its events and their conditions, then its errors and warnings; the file's own last. A file with no
 * error ends on "Pack is valid".
 */
export function packPreviewView(result) {
    const heading = result.packs.length > 1
        ? { parts: [{ name: `${result.packs.length} ` }, { text: 'packs in this file' }, { name: ' — ' }, { text: 'all install together or none do' }] }
        : null;
    const lines = [];
    for (const per of result.packs) {
        const triggers = (per.pack.triggers && typeof per.pack.triggers === 'object') ? per.pack.triggers : {};
        const keys = Object.keys(triggers);
        const series = keys.length ? String((triggers[keys[0]] || {}).series || '') : '';
        const parts = [{ name: `${per.pack.packId} v${per.pack.version || '?'} · ` }, { text: 'series' }, { name: ` ${series} · ${keys.length} ` }, { text: 'events' }];
        if (per.action === 'upgrade') parts.push({ name: ' · ' }, { text: 'upgrade from' }, { name: ` v${per.installedVer}` });
        lines.push({ icon: 'fa-calendar-days', parts });
        for (const key of keys) {
            const row = triggers[key] || {};
            const condition = row.whenAny ? (Array.isArray(row.whenAny) ? row.whenAny.join('  OR  ') : String(row.whenAny)) : String(row.when || '');
            lines.push({ icon: 'fa-angle-right', parts: [{ name: `${key} ` }, { code: condition }] });
        }
        for (const error of per.errors) lines.push({ status: 'danger', name: `${per.pack.packId}: ${error}` });
        for (const warning of per.warnings) lines.push({ status: 'warning', name: `${per.pack.packId}: ${warning}` });
    }
    for (const error of result.errors) lines.push({ status: 'danger', name: error });
    for (const warning of result.warnings) lines.push({ status: 'warning', name: warning });
    if (!fileErrors(result).length) lines.push({ text: 'Pack is valid', status: 'success' });
    return { heading, lines };
}
