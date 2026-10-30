// side-panel/side-panel.js — the mvu-helper-owned side panel: one slot per installed artifact whose
// card carries a panel entry — the active GameLogic Pack and every plugin — docked to the right of the
// chat, each slot collapsible, ordered by the `sidePanel.order` setting then registry install order. It
// re-renders, debounced, whenever the state may have changed: MVU's VARIABLE_UPDATE_ENDED (every parse),
// MVU_STATE_SAVED_EVENT (every state save mvu-helper makes, which MVU announces nowhere), and the message
// events. The read is the latest message's current swipe on the MAIN page (the stale-iframe rule
// applies to frames).
//
// The panel BINDS to stat_data and parses no prose. Every render decision is pure (side-panel-core.js);
// this file owns DOM, settings, and event wiring only. The format: devdoc/side-panel-format.md.
import { eventSource, event_types } from '../../../../../../../script.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { getProfile, saveSettingsDebounced } from '../../sillytavern/settings-store.js';
import { getStandaloneLorebookEntries } from '../../sillytavern/lorebook.js';
import { applyHelperLocale } from '../../sillytavern/i18n.js';
import { findEntryByNeedle, panelEntryComment } from '../../shared/card-artifact-store.js';
import { applyRegionAttributes } from '../../shared/rendered-region.js';
import {
    readPluginRegistryFrom, readLatestStatData, pluginEngineScope, pluginOwnRoot, planExposesMatch,
    PLUGIN_TYPE,
} from '../gamelogic-plugin/index.js';
import { readActivePackIdFrom, readActiveExposesFrom } from '../gamelogic-pack/index.js';
import { getEngineScopeApi, engineIdentity, GAME_ENGINE_SCOPE } from '../logic-engine/index.js';
import { MVU_VARIABLE_UPDATE_ENDED, MVU_STATE_SAVED_EVENT } from '../../sillytavern/mvu-bridge-core.js';
import {
    parsePanelDeclaration, orderSlots, renderSlotModel, normalizeRenderedPanel, resolveStatePath, sidePanelSettingsOf,
} from './side-panel-core.js';

const log = createModuleLog('side-panel');

const PANEL_ID = 'mvuh-side-panel';
const FAB_ID = 'mvuh-side-panel-fab';
const RENDER_DEBOUNCE_MS = 300;

// Per-session UI state that has no business in settings: which tab each slot is showing.
const activeTabBySlot = {};
// Warnings already logged this chat. The panel re-renders on every state change, several times a turn,
// so each warning — an unresolved path, a refused paint, a declaration that does not parse, a renderPanel
// that fails — is logged once per chat, not once per render.
let warnedThisChat = new Set();

function warnOnce(slotId, message, error) {
    const key = slotId + '\u0001' + message + (error ? '\u0001' + String((error && error.message) || error) : '');
    if (warnedThisChat.has(key)) return;
    warnedThisChat.add(key);
    if (error) log.warn('"' + slotId + '" ' + message, error);
    else log.warn('"' + slotId + '" ' + message);
}

// This card's side-panel view state; the template and the repair are side-panel-core.js.
function sidePanelSettings() {
    return sidePanelSettingsOf(getProfile());
}

// ── slot collection ──────────────────────────────────────────────────────────

// Every artifact on this card that declared a panel: the active pack (scope = the stat_data root)
// and each installed plugin (scope = its own drawer). Registry order is preserved — orderSlots
// puts the configured ids first and these after, in this order.
async function collectSlots() {
    const entries = await getStandaloneLorebookEntries();
    if (entries === null) return null;                       // book not ready — keep the last render
    const slots = [];
    const packId = readActivePackIdFrom(entries);
    if (packId) {
        const entry = findEntryByNeedle(entries, panelEntryComment('gamelogic', packId).toLowerCase());
        if (entry) slots.push({ id: packId, kind: 'gamelogic', entry, scopePath: '', engineScope: GAME_ENGINE_SCOPE, record: null });
    }
    const { registry, error } = readPluginRegistryFrom(entries);
    if (!error) {
        for (const rec of registry.activePlugins) {
            const entry = findEntryByNeedle(entries, panelEntryComment(PLUGIN_TYPE, rec.id).toLowerCase());
            if (entry) slots.push({ id: rec.id, kind: PLUGIN_TYPE, entry, scopePath: pluginOwnRoot(rec.stateName), engineScope: pluginEngineScope(rec.id), record: rec });
        }
    }
    return { slots, entries };
}

// ── the render loop ──────────────────────────────────────────────────────────

async function buildSlotModel(slot, statData, entries) {
    const parsed = parsePanelDeclaration(slot.entry.content);
    if (parsed.error) {
        warnOnce(slot.id, parsed.error + ' — the slot is skipped until the declaration is fixed');
        return null;
    }
    if (parsed.skippedKind) {
        log.verbose('"' + slot.id + '" declares kind "' + parsed.skippedKind + '" — this build renders slot-list only; the slot is skipped');
        return null;
    }
    const scope = resolveStatePath(statData, slot.scopePath);
    const ownState = scope.found ? scope.value : undefined;
    // The exposes map (interface token → the game path the active pack points it at), resolved for THIS
    // slot: a plugin sees only the interfaces it declared, a pack sees its own. Both lanes read it — the
    // declaration's `{token}` escape and the hook's ctx — so it is resolved once here rather than per path.
    const exposesMap = slot.record
        ? planExposesMatch({ requires: slot.record.requires, optionalUses: slot.record.optionalUses, exposes: readActiveExposesFrom(entries) }).resolved
        : readActiveExposesFrom(entries);

    // The renderPanel hook: a hosted resolver that computes its view. The ctx is the relay's read side
    // without the turn fields; output that does not fit, or a throw, renders the bound declaration below.
    const api = getEngineScopeApi(slot.engineScope);
    if (api && typeof api.renderPanel === 'function') {
        try {
            const rendered = await api.renderPanel({ ownState, snapshot: statData, engine: engineIdentity(), exposes: exposesMap });
            const norm = normalizeRenderedPanel(rendered);
            if (norm) return norm;
            warnOnce(slot.id, 'renderPanel returned nothing usable — rendering from its bound declaration instead');
        } catch (e) {
            warnOnce(slot.id, 'renderPanel threw — rendering from its bound declaration instead:', e);
        }
    }
    return renderSlotModel(parsed.declaration, ownState, { snapshot: statData, exposes: exposesMap });
}

let renderTimer = null;
function scheduleRender() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => { renderTimer = null; void renderSidePanel(); }, RENDER_DEBOUNCE_MS);
}

async function renderSidePanel() {
    const panel = document.getElementById(PANEL_ID);
    const fab = document.getElementById(FAB_ID);
    if (!panel || !fab) return;
    try {
        const collected = await collectSlots();
        if (collected === null) return;
        const { slots, entries } = collected;
        if (!slots.length) {
            panel.style.display = 'none';
            fab.style.display = 'none';
            return;
        }
        fab.style.display = '';
        const cfg = sidePanelSettings();
        panel.style.display = cfg.open ? '' : 'none';
        fab.querySelector('i').className = 'fa-solid ' + (cfg.open ? 'fa-chevron-right' : 'fa-chevron-left');
        if (!cfg.open) return;

        const statData = readLatestStatData() || {};
        const byId = new Map(slots.map((s) => [s.id, s]));
        const ordered = orderSlots(slots.map((s) => s.id), cfg.order);

        const host = panel.querySelector('.mvuh-sp-slots');
        host.innerHTML = '';
        for (const id of ordered) {
            const slot = byId.get(id);
            const model = await buildSlotModel(slot, statData, entries);
            if (!model) continue;
            for (const w of (model.warnings || [])) warnOnce(id, w);
            host.appendChild(buildSlotElement(slot, model, ordered, cfg));
        }
        void applyHelperLocale();       // rebuilt markup carries data-i18n keys
    } catch (e) {
        log.warn('render failed (non-fatal — the panel keeps its last content):', e);
    }
}

// ── DOM ──────────────────────────────────────────────────────────────────────

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function buildSlotElement(slot, model, ordered, cfg) {
    const wrap = el('div', 'mvuh-sp-slot');
    const head = el('div', 'mvuh-sp-slot-head');
    const collapsed = !!cfg.collapsedSlots[slot.id];

    const caret = el('span', 'mvuh-sp-caret', collapsed ? '▸' : '▾');
    const title = el('span', 'mvuh-sp-slot-title', model.title || slot.id);
    head.appendChild(caret); head.appendChild(title);

    // The ordering GUI: two arrows writing sidePanel.order — the full current order with this slot
    // swapped, so the setting always names every present slot and stays readable by hand.
    const tools = el('span', 'mvuh-sp-slot-tools');
    const mkMove = (dir, glyph, i18nKey) => {
        const b = el('span', 'mvuh-sp-tool', glyph);
        b.title = i18nKey; b.setAttribute('data-i18n', '[title]' + i18nKey);
        b.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const i = ordered.indexOf(slot.id);
            const j = i + dir;
            if (j < 0 || j >= ordered.length) return;
            const next = ordered.slice();
            [next[i], next[j]] = [next[j], next[i]];
            sidePanelSettings().order = next;
            saveSettingsDebounced();
            void renderSidePanel();
        });
        return b;
    };
    tools.appendChild(mkMove(-1, '↑', 'Move slot up'));
    tools.appendChild(mkMove(1, '↓', 'Move slot down'));
    head.appendChild(tools);

    head.addEventListener('click', () => {
        sidePanelSettings().collapsedSlots[slot.id] = !sidePanelSettings().collapsedSlots[slot.id];
        saveSettingsDebounced();
        void renderSidePanel();
    });
    wrap.appendChild(head);
    if (collapsed) return wrap;

    const body = el('div', 'mvuh-sp-slot-body');
    const tabs = model.tabs || [];
    let active = activeTabBySlot[slot.id];
    if (!tabs.some((t) => t.id === active)) active = tabs.length ? tabs[0].id : '';
    if (tabs.length > 1) {
        const strip = el('div', 'mvuh-sp-tabs');
        for (const t of tabs) {
            const b = el('span', 'mvuh-sp-tab' + (t.id === active ? ' mvuh-sp-tab-active' : ''), t.name);
            b.addEventListener('click', (ev) => {
                ev.stopPropagation();
                activeTabBySlot[slot.id] = t.id;
                void renderSidePanel();
            });
            strip.appendChild(b);
        }
        body.appendChild(strip);
    }
    const tab = tabs.find((t) => t.id === active);
    appendBlocks(body, tab ? tab.blocks : []);
    wrap.appendChild(body);
    return wrap;
}

// The blocks of ONE level. A collection group may carry blocks of its own, so this recurses and each
// nested level is indented under its group heading — the model is recursive, so the builder is too.
function appendBlocks(host, blocks) {
    for (const block of (blocks || [])) {
        // A block's own heading, when it declared one: what lets several unrelated fields sit under
        // one band instead of only under a collection key.
        if (block.heading) {
            const band = el('div', 'mvuh-sp-heading', block.heading);
            paintCell(band, (block.style || {}).heading);
            host.appendChild(band);
        }
        if (block.type === 'fields') { host.appendChild(buildRows(block.rows)); continue; }
        if (block.type !== 'collection') continue;
        if (block.missing || !block.groups.length) { host.appendChild(el('div', 'mvuh-sp-empty-note', '—')); continue; }
        for (const g of block.groups) {
            const head = el('div', 'mvuh-sp-group-key', g.key);
            paintCell(head, (g.style || {}).groupKey);
            host.appendChild(head);
            host.appendChild(buildRows(g.rows));
            if (g.blocks && g.blocks.length) {
                const nest = el('div', 'mvuh-sp-nest');
                appendBlocks(nest, g.blocks);
                host.appendChild(nest);
            }
        }
    }
}

// One cell's declared paint. The colours were validated as hex literals in the core, so nothing but a
// colour literal reaches a style property. A cell with a ground gains padding, or its colour would run
// edge to edge against the next one.
function paintCell(node, paint) {
    if (!paint) return;
    if (paint.color) node.style.color = paint.color;
    if (paint.background) {
        // The shorthand takes BOTH a colour and a gradient, so one property serves every paint the
        // core can produce — and the core built that string from validated hex, never author text.
        node.style.background = paint.background;
        node.classList.add('mvuh-sp-filled');
    }
}

function buildRows(rows) {
    const table = el('div', 'mvuh-sp-rows');
    for (const r of rows) {
        const row = el('div', 'mvuh-sp-row');
        const label = el('span', 'mvuh-sp-label', r.label);
        row.appendChild(label);
        const cell = el('span', 'mvuh-sp-value' + (r.missing ? ' mvuh-sp-missing' : ''), r.value || (r.missing ? '·' : ''));
        row.appendChild(cell);
        paintCell(label, (r.style || {}).label);
        paintCell(cell, (r.style || {}).value);
        paintCell(row, (r.style || {}).row);
        table.appendChild(row);
    }
    return table;
}

const PANEL_CSS = `
#${PANEL_ID} { position: fixed; right: 28px; top: 60px; width: 320px; max-height: 72vh; z-index: 3000;
  background: var(--SmartThemeBlurTintColor, rgba(20,20,20,.92)); color: var(--SmartThemeBodyColor, #ddd);
  border: 1px solid var(--SmartThemeBorderColor, #444); border-radius: 8px; overflow-y: auto;
  font-size: 0.85em; backdrop-filter: blur(4px); }
#${PANEL_ID} .mvuh-sp-header { padding: 6px 10px; font-weight: bold; border-bottom: 1px solid var(--SmartThemeBorderColor, #444); }
#${PANEL_ID} .mvuh-sp-slot { border-bottom: 1px solid var(--SmartThemeBorderColor, #333); }
#${PANEL_ID} .mvuh-sp-slot-head { display: flex; align-items: center; gap: 6px; padding: 5px 10px; cursor: pointer; }
#${PANEL_ID} .mvuh-sp-slot-title { flex: 1 1 auto; font-weight: bold; }
#${PANEL_ID} .mvuh-sp-tool { cursor: pointer; opacity: .6; padding: 0 3px; }
#${PANEL_ID} .mvuh-sp-tool:hover { opacity: 1; }
#${PANEL_ID} .mvuh-sp-slot-body { padding: 4px 10px 8px; }
#${PANEL_ID} .mvuh-sp-tabs { display: flex; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
#${PANEL_ID} .mvuh-sp-tab { cursor: pointer; opacity: .6; }
#${PANEL_ID} .mvuh-sp-tab-active { opacity: 1; font-weight: bold; text-decoration: underline; }
#${PANEL_ID} .mvuh-sp-row { display: flex; gap: 8px; padding: 1px 0; }
#${PANEL_ID} .mvuh-sp-label { flex: 0 0 38%; opacity: .7; overflow: hidden; text-overflow: ellipsis; }
#${PANEL_ID} .mvuh-sp-value { flex: 1 1 auto; word-break: break-word; }
#${PANEL_ID} .mvuh-sp-missing { opacity: .35; }
/* A cell with a declared ground needs room to read as one; text colour needs no rule at all. */
#${PANEL_ID} .mvuh-sp-filled { padding: 0 4px; border-radius: 3px; }
#${PANEL_ID} .mvuh-sp-group-key { font-weight: bold; margin-top: 4px; }
/* A block heading is a band: full width, its own padding, so a declared ground reads as a header. */
#${PANEL_ID} .mvuh-sp-heading { font-weight: bold; letter-spacing: .04em; margin: 6px 0 3px;
  padding: 3px 6px; border-radius: 4px; }
/* A nested level is indented under its group, with a rule showing what it hangs off. */
#${PANEL_ID} .mvuh-sp-nest { margin-left: 10px; padding-left: 6px; border-left: 1px solid var(--SmartThemeBorderColor, #444); }
#${PANEL_ID} .mvuh-sp-empty-note { opacity: .5; }
#${FAB_ID} { position: fixed; right: 0; top: 46%; z-index: 3000; padding: 10px 4px; cursor: pointer;
  background: var(--SmartThemeBlurTintColor, rgba(20,20,20,.85)); color: var(--SmartThemeBodyColor, #ddd);
  border: 1px solid var(--SmartThemeBorderColor, #444); border-right: none; border-radius: 6px 0 0 6px; }
`;

// ── wiring ───────────────────────────────────────────────────────────────────

export function wireSidePanel() {
    if (document.getElementById(PANEL_ID)) return;
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    document.head.appendChild(style);

    // Both of these mount as direct children of `<body>`, where an extension sweeping the page has no
    // message subtree to bound its search. The id is ours to change; the region attributes are the
    // published boundary, so anything that wants to move, hide or skip our chrome can match on them
    // instead of inferring which stray body child is whose.
    const panel = el('div');
    panel.id = PANEL_ID;
    applyRegionAttributes(panel, 'side-panel');
    panel.style.display = 'none';
    const header = el('div', 'mvuh-sp-header', 'Side Panel');
    header.setAttribute('data-i18n', 'Side Panel');
    panel.appendChild(header);
    panel.appendChild(el('div', 'mvuh-sp-slots'));
    document.body.appendChild(panel);

    const fab = el('div');
    fab.id = FAB_ID;
    applyRegionAttributes(fab, 'side-panel-toggle');
    fab.style.display = 'none';
    fab.title = 'Side Panel';
    fab.setAttribute('data-i18n', '[title]Side Panel');
    fab.appendChild(el('i'));
    fab.querySelector('i').className = 'fa-solid fa-chevron-left';
    fab.addEventListener('click', () => {
        sidePanelSettings().open = !sidePanelSettings().open;
        saveSettingsDebounced();
        void renderSidePanel();
    });
    document.body.appendChild(fab);

    // The render triggers. VARIABLE_UPDATE_ENDED is every parse (narrate, POST, the relay's own);
    // MVU_STATE_SAVED_EVENT is every save through the bridge's save door (the turn runner's RES1 and
    // RES2, the PRE apply, a menu action, a sync pass, a plugin's drawer), which fires no MVU event; the
    // message events cover a reply that arrives, changes or swipes; CHAT_CHANGED resets the per-chat
    // warning dedupe and repaints for the new card's artifact set.
    eventSource.on(MVU_VARIABLE_UPDATE_ENDED, scheduleRender);
    eventSource.on(MVU_STATE_SAVED_EVENT, scheduleRender);
    if (event_types.MESSAGE_UPDATED) eventSource.on(event_types.MESSAGE_UPDATED, scheduleRender);
    if (event_types.MESSAGE_RECEIVED) eventSource.on(event_types.MESSAGE_RECEIVED, scheduleRender);
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, scheduleRender);
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => { warnedThisChat = new Set(); scheduleRender(); });
    }
    scheduleRender();
    log.lifecycle('wired — slots render for every installed artifact carrying a panel entry');
}

