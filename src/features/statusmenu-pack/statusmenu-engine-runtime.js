// statusmenu-pack/statusmenu-engine-runtime.js — the RUNNING half of the menu engine (G3.4/G3.6):
// the Worker text source, the layout↔exports cross-check, and the formatter batch pre-pass.
//
// The engine text boots into the SHARED Worker beside the game and plugin engines (§9.2 — one card,
// one Worker, one capability block; swapping ANY text restarts it and reloads all). This feature
// registers the source at composition time (src/index.js, registerEngineTextSource) and reaches its
// scope through the loader's per-scope API — it never touches the Worker directly.

import { createModuleLog } from '../../sillytavern/log.js';
import { getStandaloneLorebookEntries } from '../../sillytavern/lorebook.js';
import { findEntryByNeedle, ARTIFACT_ROLES } from '../../shared/card-artifact-store.js';
import { getEngineScopeApi, callEngineScopeBatch } from '../logic-engine/index.js';
import { menuLayoutComment, layoutFormatterNames, missingFormatterNames, layoutActionNames, missingActionNames, menuFormatterCalls } from './statusmenu-pack-core.js';
import { readMenuEngineCode, readEmbeddedMenuEngineCode } from './statusmenu-engine-store.js';
import { readMenuRegistryFrom } from './statusmenu-pack-activation.js';

const log = createModuleLog('statusmenu-pack');

// The Worker scope the menu engine loads under. A literal, because there is ONE menu per card —
// unlike plugins there is no id to namespace by — and the shape collides with neither the game's
// scope ('game') nor a plugin's ('plugin:<id>').
export const MENU_ENGINE_SCOPE = 'statusmenu';

// ── the engine-text source (registered with the loader) ──────────────────────

// The [MVU_StatusMenuEngine] text for the shared Worker's N-text boot. Standalone book first (the
// authoritative copy — the dev lane and pack activation both write there), embedded card book as the
// CHAT_CHANGED-gap fallback, exactly like the game engine's own read order.
export async function readMenuEngineTexts() {
    let read = await readMenuEngineCode();
    if (read === null) read = readEmbeddedMenuEngineCode();
    const code = (read && read.found) ? String(read.text || '') : '';
    if (!code.trim()) return [];
    // kind: the loader groups its reload line by this word and never interprets it. "display engine"
    // because that is what this IS — the user-facing counterpart of the game's Logic Engine, the same
    // game seen from the player's side, NOT a plugin and not an extra hosted next to it.
    return [{ scope: MENU_ENGINE_SCOPE, code, kind: ARTIFACT_ROLES.statusmenu.engineLabel }];
}

// ── the installed layout ─────────────────────────────────────────────────────

// The ACTIVE menu's installed layout, parsed from its [StatusMenuPack:<id>] (Layout) entry.
// null = no active menu, no layout entry, or an unparseable one — the last is WARNED (a hand-edit
// broke it; reading it as "no layout" without saying so would make the menu vanish silently).
export async function readInstalledMenuLayout() {
    const entries = await getStandaloneLorebookEntries();
    if (entries === null) return null;
    const { registry } = readMenuRegistryFrom(entries);
    if (!registry) return null;
    const entry = findEntryByNeedle(entries, menuLayoutComment(registry.activeMenuId).toLowerCase());
    if (!entry) return null;
    try { return JSON.parse(String(entry.content || '')); }
    catch (e) {
        log.warn('the installed layout entry for "' + registry.activeMenuId + '" is not valid JSON — the menu cannot render from it:', e);
        return null;
    }
}

// ── the cross-check (§9.3's dev-lane hazard) ─────────────────────────────────

// The layout names formatters that live in the engine text, so uploading one half alone can leave
// the layout referencing an export that no longer exists. ONE warn, ENUMERATING the missing — never
// a refusal (§10a: the menu still renders, those cells fall to raw).
// Returns the missing names, so activation's log line and a test can read the verdict directly.
export async function checkMenuFormatterCoverage() {
    const layout = await readInstalledMenuLayout();
    if (!layout) return [];
    const wanted = layoutFormatterNames(layout);
    if (!wanted.length) return [];
    const api = getEngineScopeApi(MENU_ENGINE_SCOPE);
    // No scope at all = no engine text hosted (or the Worker is not up). The layout wanting
    // formatters THEN is the same finding with a different cause, and the warn says which.
    const exported = api
        ? Object.keys(api).filter((k) => k.startsWith('formatters.')).map((k) => k.slice('formatters.'.length))
        : [];
    const missing = missingFormatterNames(layout, exported);
    if (missing.length) {
        log.warn('the installed layout names ' + missing.length + ' formatter(s) the '
            + (api ? 'StatusMenu Engine does not export' : 'card has no StatusMenu Engine to serve')
            + ': ' + missing.join(', ') + ' — those cells render raw until the pair matches (§10a).');
    }
    return missing;
}

// The WRITE half of the same cross-check. A layout declares which verbs its buttons post; the engine
// says which it can serve. A menu that declares none is VIEW-ONLY and completely valid — it asks
// nothing here and hears nothing. One that declares verbs the engine lacks still installs and still
// renders every value it draws; each button refuses by name at click time, and this is the line that
// says so at INSTALL instead, when the person who can fix it is still looking.
// Returns the missing names so activation's log line and a test can read the verdict directly.
export async function checkMenuActionCoverage() {
    const layout = await readInstalledMenuLayout();
    if (!layout) return [];
    const wanted = layoutActionNames(layout);
    if (!wanted.length) return [];                 // view-only: nothing promised, nothing to check
    const api = getEngineScopeApi(MENU_ENGINE_SCOPE);
    const exported = api
        ? Object.keys(api).filter((k) => k.startsWith('actions.')).map((k) => k.slice('actions.'.length))
        : [];
    const missing = missingActionNames(layout, exported);
    if (missing.length) {
        // "exports no actions at all" is the whole truth when the count is zero, and it covers the
        // verbs a renderer posts from a cell's shape without this file having to name any of them.
        const lack = !api ? 'card has no StatusMenu Engine to serve'
            : (exported.length ? 'StatusMenu Engine does not export' : 'StatusMenu Engine exports NO actions at all, so it cannot serve');
        log.warn('the installed layout declares ' + missing.length + ' action(s) the '
            + lack + ': ' + missing.join(', ') + ' — the menu renders, and every button posting one of those'
            + ' refuses by name until the engine gains it (§10a).');
    }
    return missing;
}

// ── the formatter pre-pass (§9.5/G3.6 — mvu-helper's half of the seam) ───────

// Resolve a batch of formatter requests against one stat_data snapshot, in ONE Worker round trip
// (N fields, one call, so the caller renders synchronously from the returned map).
//
// The CALLER builds the requests. Which cells exist, and what `stat` MEANS for each one, are the
// renderer's questions — a cell inside a collection is handed its ITEM, and only the code drawing
// that collection knows which items there are. This side resolves declared paths and routes the
// calls; it reads no layout structure, so a second layout kind needs nothing here.
//
// A request is { cellId, field, formatterName, scopePath }: `scopePath` is an absolute dotted path
// whose value becomes the formatter's first argument (empty = the whole snapshot) and which is itself
// its third (menuFormatterCalls), and `cellId` is whatever the caller uses to find the answer again —
// for a per-item cell it MUST carry the item identity, or two items collide on one key.
//
// Returns { map, missing } — a map key joins cellId and field with U+0001, which no path or field
// name can contain, so no two requests can forge each other's key; values are the formatter's
// string. `missing` holds the formatter names that could not answer (absent export, throw, or no
// Worker). Misses are marked, warned ONCE per name, and NEVER hole the map — the renderer falls
// back to the raw value for those cells (§10).
// null = nothing was asked for.
export async function runMenuFormatterPrePass(statData, requests) {
    if (!Array.isArray(requests)) return null;
    if (!requests.length) return { map: {}, missing: [] };

    const results = await callEngineScopeBatch(MENU_ENGINE_SCOPE, menuFormatterCalls(statData, requests));

    const map = {};
    const missing = new Set();
    requests.forEach((r, i) => {
        const res = results === null ? { ok: false, missing: true } : (results[i] || { ok: false, missing: true });
        if (res.ok) map[r.cellId + '' + r.field] = String(res.value);
        else {
            missing.add(r.formatterName);
            if (res.error) log.warn('formatter "' + r.formatterName + '" threw for cell ' + r.cellId + ' — its cell renders raw: ' + res.error);
        }
    });
    if (missing.size) {
        log.warn('formatter pre-pass: ' + missing.size + ' formatter(s) did not answer'
            + (results === null ? ' (no engine Worker is hosted)' : '')
            + ': ' + [...missing].join(', ') + ' — their cells render raw (§10).');
    }
    return { map, missing: [...missing] };
}
