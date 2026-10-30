// side-panel/side-panel-core.js — pure logic for the side panel: declaration parsing, slot ordering,
// path resolution against a state scope, and the ONE render model both sources produce — a declaration
// bound to live state, and a `renderPanel` engine hook's computed output. No host imports; every decision
// here is unit-tested, because the panel is a READER of other artifacts' state and a reader that guesses
// draws lies. The format it reads: devdoc/side-panel-format.md.

import { unwrapTupleValue } from '../../shared/mvu-tuple.js';
import { isPrototypeKey } from '../../shared/object-path.js';

// PER-CARD defaults (PROFILE scope) — merged into profileDefaults by index.js. The panel's own view state:
//   order          — slot ids in the order the arrows set; slots not named follow in registry order
//   open           — whether the panel is shown (the edge toggle)
//   collapsedSlots — { <slot id>: true } for each slot folded to its header
export const sidePanelProfileDefaults = {
    sidePanel: { order: [], open: false, collapsedSlots: {} },
};

// This card's side-panel block, its present-but-wrong-typed fields repaired. On a valid block, the template
// included, it writes nothing: in the lobby the profile is frozen (sillytavern/settings-store-core.js
// profileRecordFor).
export function sidePanelSettingsOf(p) {
    const d = sidePanelProfileDefaults.sidePanel;
    if (!p.sidePanel || typeof p.sidePanel !== 'object') p.sidePanel = structuredClone(d);
    const s = p.sidePanel;
    if (!Array.isArray(s.order)) s.order = [];
    if (typeof s.open !== 'boolean') s.open = d.open;
    if (!s.collapsedSlots || typeof s.collapsedSlots !== 'object') s.collapsedSlots = {};
    return s;
}

// The one declaration kind this build renders. At the top level the host reads `kind` and `format` and
// nothing else: a declaration of another kind is SKIPPED with its kind named — never an error, so a future
// kind ships without a host change and an old host degrades honestly.
export const SLOT_LIST_KIND = 'slot-list';

// Caps — a panel is a glance surface, not a database dump. Everything over a cap is dropped rather
// than scrolled forever; the caps are shared by both model sources so neither can smuggle more.
export const PANEL_CAPS = { tabs: 8, blocks: 8, rows: 64, groups: 64, valueChars: 400, colorRules: 8, depth: 3, gradientStops: 6 };

// A panel entry's content → { declaration } | { skippedKind } | { error }. Malformed JSON and a
// non-object are ERRORS (the artifact shipped a broken declaration — its author must hear it); an
// unknown kind is a SKIP (the artifact is from the future — nothing is broken).
export function parsePanelDeclaration(content) {
    let parsed;
    // EXPECTED throw: the content is author-supplied JSON and "does it parse" is the question.
    try { parsed = JSON.parse(String(content == null ? '' : content)); }
    catch (e) { return { error: 'the panel entry does not parse as JSON: ' + (e && e.message || e) }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'the panel entry is not a JSON object' };
    if (String(parsed.kind || '') !== SLOT_LIST_KIND) return { skippedKind: String(parsed.kind || '(none)') };
    return { declaration: parsed };
}

// Slot order: configured ids first, in the setting's own order; everything unlisted follows in the order
// given (registry install order). Ids in the setting that are not installed are ignored, so a stale
// setting can never conjure a slot.
export function orderSlots(slotIds, configuredOrder) {
    const present = new Set(slotIds || []);
    const out = [];
    for (const id of (configuredOrder || [])) if (present.has(id) && !out.includes(id)) out.push(id);
    for (const id of (slotIds || [])) if (!out.includes(id)) out.push(id);
    return out;
}

// A dotted path read against the slot's OWN state scope ('' = the scope itself). Returns
// { found, value } — found:false is "nothing at this path", which renders empty with a warning,
// never a refused slot. A prototype key finds nothing (shared/object-path.js says why).
export function resolveStatePath(scopeState, dottedPath) {
    const path = String(dottedPath == null ? '' : dottedPath);
    let node = scopeState;
    if (path !== '') {
        for (const seg of path.split('.')) {
            if (!node || typeof node !== 'object' || isPrototypeKey(seg)) return { found: false, value: undefined };
            node = node[seg];
        }
    }
    if (node === undefined) return { found: false, value: undefined };
    return { found: true, value: node };
}

// The three path FORMS a declaration may write. A bare path is relative to the slot's own scope and is
// what a slot uses for its own drawer. Two escapes reach outside it, because a plugin that decorates the
// game's state must be able to SHOW the thing it decorates, as its engine lane can (`resolveRelay` gets
// the whole snapshot):
//   {token}.rest — `token` is one of THIS artifact's declared interfaces, resolved through the
//                  active pack's exposes map ({"cast@1": "Classmate"}) and then read from the
//                  stat_data root. The plugin never writes the pack's vocabulary, so the same
//                  declaration works against any pack exposing that interface.
//   $.rest       — a raw absolute path from the stat_data root. No indirection and no portability:
//                  the author is stating they know THIS card's shape. `$` alone is the root.
// The escapes mean the same thing wherever they appear — inside a collection's per-child fields
// included, where the relative root is the child rather than the scope.
export function parsePathSpec(path) {
    const raw = String(path == null ? '' : path).trim();
    const token = /^\{([^}]*)\}\.?(.*)$/.exec(raw);
    if (token) return { kind: 'token', token: token[1].trim(), path: token[2] };
    if (raw === '$') return { kind: 'root', path: '' };
    if (raw.startsWith('$.')) return { kind: 'root', path: raw.slice(2) };
    return { kind: 'own', path: raw };
}

// One declared path resolved against whichever root its form names. `relativeRoot` is the row's
// current relative root (the slot scope, or a collection child); `context` carries the panel-wide
// `{ snapshot, exposes }` the escapes read. Returns the resolveStatePath shape plus `unresolvedToken`
// when a token names an interface the active pack does not expose — a distinct fact from "the path
// led nowhere", and the caller warns with the token named.
export function resolvePanelPath(pathSpec, relativeRoot, context) {
    const spec = parsePathSpec(pathSpec);
    const ctx = (context && typeof context === 'object') ? context : {};
    if (spec.kind === 'own') return resolveStatePath(relativeRoot, spec.path);
    if (spec.kind === 'root') return resolveStatePath(ctx.snapshot, spec.path);
    const exposes = (ctx.exposes && typeof ctx.exposes === 'object') ? ctx.exposes : {};
    const target = exposes[spec.token];
    if (!target) return { found: false, value: undefined, unresolvedToken: spec.token };
    return resolveStatePath(ctx.snapshot, String(target) + (spec.path ? '.' + spec.path : ''));
}

// One displayable string for a leaf value. Objects and long arrays are summarised, never dumped —
// a collection block is the sanctioned way to show structure.
export function displayValue(v) {
    const un = unwrapTupleValue(v);
    if (un === undefined || un === null) return '';
    let s;
    if (typeof un === 'string') s = un;
    else if (typeof un === 'number' || typeof un === 'boolean') s = String(un);
    else if (Array.isArray(un)) s = un.map((x) => displayValue(x)).join(', ');
    else if (typeof un === 'object') s = '{' + Object.keys(un).length + ' keys}';
    else s = String(un);
    return s.length > PANEL_CAPS.valueChars ? s.slice(0, PANEL_CAPS.valueChars - 1) + '…' : s;
}

// Is the slot's own drawer empty — no key written into it yet? Its own-scope paths then CANNOT
// resolve, every one of them, and saying so per path states one fact as many.
export function isOwnScopeEmpty(scopeState) {
    return !scopeState || typeof scopeState !== 'object' || Object.keys(scopeState).length === 0;
}

// The ONE sentence an empty drawer earns, in place of the per-path pile. It names both readings
// because the console cannot tell them apart and the reader can: a plugin installed this turn has
// written nothing yet, and a plugin whose writes are being refused looks identical from here. The
// COUNT is carried so nothing is hidden — the reader is told how many bindings this one line stands in
// for, and a declaration whose paths are genuinely wrong still shows a number worth questioning.
export function emptyOwnScopeWarning(suppressedCount) {
    return "this plugin's own drawer is EMPTY, so all " + suppressedCount + ' path(s) bound to it render blank'
        + ' — either it has not written yet (normal before its first turn) or its writes are being refused'
        + ' (the MVU/relay lines above name which gatekeeper turned them down)';
}

// The one warning sentence for a path that produced no value, naming WHY: an unexposed token and a
// dead path are different author mistakes and read differently.
//
// Returns NULL for an own-scope path when the drawer is empty — not silence, a REPLACEMENT: the
// single emptyOwnScopeWarning above is emitted once for the slot instead, naming the drawer every one of
// those bindings shares rather than one line per binding pointing at the declaration.
function missingPathWarning(where, pathSpec, resolved, ownScopeEmpty) {
    if (resolved.unresolvedToken) {
        return where + ': token "{' + resolved.unresolvedToken + '}" is not exposed by the active pack — nothing to read';
    }
    // Only OWN-scope paths are covered by the drawer being empty. A `$.` or `{token}` path reads
    // somewhere else entirely, so its failure is its own fact and still gets named.
    if (ownScopeEmpty && parsePathSpec(pathSpec).kind === 'own') return null;
    return where + ': path "' + String(pathSpec || '') + '" resolved to nothing';
}

// A colour is the AUTHOR's hex, so the helper hardcodes no palette of its own.
// STRICTLY hex — #rgb, #rgba, #rrggbb, #rrggbbaa — and nothing else: these strings are handed to a
// style property, and anything that is not a colour literal has no business being written there.
// A rejected value is REPORTED, never quietly dropped.
//
// The cost the author owns: a hex ignores SillyTavern's theme, so a colour picked against a dark
// ground can read badly on a light one. The panel cannot see that and will not pretend to.
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
export function isPanelColor(value) {
    return typeof value === 'string' && HEX_COLOR.test(value.trim());
}

// A value as a NUMBER, for the threshold tests only. Not `Number(v)`: that reads '', null, false and
// [] as ZERO, so an empty stat would satisfy `{ lt: 20 }` and paint itself red — a verdict about a
// value the card does not have. Only a real number or a non-blank numeric string counts.
function numericValue(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '') return Number(value);
    return NaN;
}

// ONE colour rule against a value. Every condition present must hold (they AND), and a rule with no
// condition at all is the DEFAULT arm — which is why rules are ordered and the first match wins.
// Numeric tests need a number: a non-numeric value fails them rather than comparing as NaN, so a
// missing stat never paints itself green.
function colorRuleMatches(rule, num, text, value) {
    if (rule.lt !== undefined && !(Number.isFinite(num) && num < Number(rule.lt))) return false;
    if (rule.lte !== undefined && !(Number.isFinite(num) && num <= Number(rule.lte))) return false;
    if (rule.gt !== undefined && !(Number.isFinite(num) && num > Number(rule.gt))) return false;
    if (rule.gte !== undefined && !(Number.isFinite(num) && num >= Number(rule.gte))) return false;
    if (rule.eq !== undefined && text !== String(rule.eq)) return false;
    if (rule.has !== undefined && !text.toLowerCase().includes(String(rule.has).toLowerCase())) return false;
    if (rule.is !== undefined && Boolean(value) !== Boolean(rule.is)) return false;
    return true;
}

// A GRADIENT, and the reason it is an OBJECT: the three paint forms have to be told apart by shape
// alone — a string is a hex, an ARRAY is already the rule list, so a list of stops could never be
// one without becoming ambiguous. `{ stops: [...], angle }` collides with neither.
//
// The CSS is BUILT here from validated pieces, never from author text: every stop goes through the
// same hex check and the angle is coerced to a finite number. That is what keeps a style property
// safe to write to.
function gradientCss(spec, report) {
    const stops = Array.isArray(spec.stops) ? spec.stops : null;
    if (!stops) { report('a gradient needs "stops": a list of 2 to ' + PANEL_CAPS.gradientStops + ' hex colours'); return ''; }
    if (stops.length < 2 || stops.length > PANEL_CAPS.gradientStops) {
        report('a gradient takes 2 to ' + PANEL_CAPS.gradientStops + ' stops, not ' + stops.length);
        return '';
    }
    const clean = [];
    for (const stop of stops) {
        const raw = String(stop == null ? '' : stop).trim();
        if (!isPanelColor(raw)) { report('gradient stop "' + raw + '" is not a hex colour'); return ''; }
        clean.push(raw);
    }
    const angle = Number(spec.angle);
    return 'linear-gradient(' + (Number.isFinite(angle) ? angle : 90) + 'deg, ' + clean.join(', ') + ')';
}

// A `color` or `background` resolved against its value. THREE forms, told apart by shape: a hex
// STRING, a rule LIST (first match wins), or a gradient OBJECT. Returns '' for no paint, and reports
// an unusable declaration through `onProblem` — a malformed hex silently painting nothing is how a
// colour rule is believed to be working when it never fires.
//
// `allowGradient` is false for TEXT: a gradient is a background, and letting one through for `color`
// would paint the text the browser's default rather than say the declaration is wrong.
export function pickRowColor(colorSpec, rawValue, onProblem, allowGradient) {
    const report = (m) => { if (typeof onProblem === 'function') onProblem(m); };
    const paint = (n) => {
        if (n && typeof n === 'object' && !Array.isArray(n)) {
            if (!allowGradient) { report('a gradient is only valid for "background", never for text'); return ''; }
            return gradientCss(n, report);
        }
        const raw = String(n == null ? '' : n).trim();
        if (!raw) return '';
        if (!isPanelColor(raw)) { report('"' + raw + '" is not a hex colour (#rgb, #rgba, #rrggbb or #rrggbbaa)'); return ''; }
        return raw;
    };
    if (colorSpec === undefined || colorSpec === null || colorSpec === '') return '';
    if (typeof colorSpec === 'string') return paint(colorSpec);
    if (!Array.isArray(colorSpec)) return paint(colorSpec);              // a gradient object, or a reported mistake
    const value = unwrapTupleValue(rawValue);
    const num = numericValue(value);
    const text = (value === null || value === undefined) ? '' : String(value);
    for (const rule of colorSpec.slice(0, PANEL_CAPS.colorRules)) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
        if (colorRuleMatches(rule, num, text, value)) return paint(rule.use);
    }
    return '';
}

// WHICH CELL a paint lands on. A row is a table row of two cells plus the row itself, so the cell is
// NAMED rather than implied — `color` sitting at field level could only ever mean one of them, and an
// author wanting a coloured label would have nowhere to say so.
export const ROW_CELLS = ['label', 'value', 'row'];
// A collection's group heading is a cell too, and it is the block's to declare because a group has no
// field. Its rules test against the KEY, which is the only value it has.
export const GROUP_CELLS = ['groupKey'];
// A BLOCK may carry a `heading`, which is a cell of its own — that is what lets several unrelated
// fields sit under one band instead of only under a collection KEY. Its rules judge the heading
// text, the only value a heading has. NOT `title`: the declaration's top-level `title` names the
// whole SLOT, and one word for both levels is a word that teaches the wrong one.
export const FIELDS_BLOCK_CELLS = ['heading'];
export const COLLECTION_BLOCK_CELLS = ['heading', 'groupKey'];

// One cell's paint: `{ color, background }`, each a hex or a rule list, both resolved against the
// same value. Returns null when nothing was declared, so a row carries only the cells it paints.
function cellPaint(spec, value, complain) {
    if (spec === undefined || spec === null) return null;
    if (typeof spec !== 'object' || Array.isArray(spec)) { complain('a cell must be an object with "color" and/or "background"'); return null; }
    const color = pickRowColor(spec.color, value, complain, false);
    const background = pickRowColor(spec.background, value, complain, true);
    return (color || background) ? { color, background } : null;
}

// A `style` block resolved against one value. ONE grammar for every cell on the panel: the keys name
// cells, each cell takes the same `{ color, background }`, and each of those takes the same hex or
// rule list. `allowedCells` is what this SITE may paint — a field names row cells, a collection block
// names its group heading — and a name outside it is reported rather than silently ignored.
export function resolveCellStyles(styleSpec, value, allowedCells, complain) {
    const out = {};
    const cells = Array.isArray(allowedCells) ? allowedCells : ROW_CELLS;
    const report = typeof complain === 'function' ? complain : () => {};
    if (styleSpec === undefined || styleSpec === null) return out;
    if (typeof styleSpec !== 'object' || Array.isArray(styleSpec)) { report('"style" must be an object naming cells (' + cells.join(', ') + ')'); return out; }
    for (const cell of Object.keys(styleSpec)) {
        if (!cells.includes(cell)) { report('unknown cell "' + cell + '" (this one paints: ' + cells.join(', ') + ')'); continue; }
        const paint = cellPaint(styleSpec[cell], value, report);
        if (paint) out[cell] = paint;
    }
    return out;
}

function fieldRows(fields, node, warnings, where, context) {
    const rows = [];
    for (const f of (Array.isArray(fields) ? fields : []).slice(0, PANEL_CAPS.rows)) {
        if (!f || typeof f !== 'object') continue;
        const r = resolvePanelPath(f.path, node, context);
        if (!r.found) {
            const w = missingPathWarning(where, f.path, r, context && context.ownScopeEmpty);
            if (w) warnings.push(w);
            else if (context && context.suppressed) context.suppressed.count += 1;
        }
        const complain = (m) => warnings.push(where + ' — "' + String(f.label || f.path || '') + '": ' + m);
        // A MISSING row is never painted: every rule is a judgement about a value, and there is no
        // value here to judge. A static colour is refused with it, so one sentence covers the case.
        const style = r.found ? resolveCellStyles(f.style, r.value, ROW_CELLS, complain) : {};
        rows.push({ label: String(f.label == null ? String(f.path || '') : f.label), value: r.found ? displayValue(r.value) : '', missing: !r.found, style });
    }
    return rows;
}

// Declaration + the slot's scope state → the render model. `context` is `{ snapshot, exposes }`,
// what the two path escapes read; omit it and only own-scope paths can resolve. Warnings COLLECT
// (the host logs each once per chat); an unresolved path renders empty rather than refusing the slot.
// Model shape — the same shape normalizeRenderedPanel produces, so the DOM builder has ONE input:
//   { title, tabs: [{ id, name, blocks: [
//       { type:'fields', heading, style, rows:[{label, value, missing, style}] } |
//       { type:'collection', heading, style, groups:[{key, style, rows, blocks}], missing } ] }], warnings: [] }
// A block's `heading` is '' when it declared none, and its `style` carries only the `heading` cell; a
// group's `style` carries only `groupKey`, judged against that group's own key.
// A group's `blocks` is the same block list one level down, so the shape is recursive and the DOM
// builder walks it with the same code at every depth.
// `style` is { <cell>: { color, background } } for the cells that declared one (ROW_CELLS on a row,
// GROUP_CELLS on a group heading); a cell that declared nothing is absent, never an empty object.
// One level of blocks, read against `node`. A COLLECTION may carry `blocks` of its own, so a level
// nests: each nested block's bare paths are relative to the group's OWN child, which is what makes
// "every classmate, and each one's belongings" expressible without naming a classmate. `fields`
// render before `blocks` within a group — one order, never a guess.
//
// `depth` starts at 1 for a tab's own blocks. The cap is a real limit, not decoration: the group cap
// applies PER LEVEL, so three levels of 64 is already more than a glance surface can carry, and a
// declaration that nests past it is told so once per block rather than silently truncated.
function buildBlocks(blocks, node, warnings, where, context, depth) {
    const out = [];
    for (const block of (Array.isArray(blocks) ? blocks : []).slice(0, PANEL_CAPS.blocks)) {
        if (!block || typeof block !== 'object') continue;
        // A block's optional heading, and the cell it paints. Its rules judge the heading TEXT, the
        // only value a heading has — the same stance groupKey takes with its key.
        const heading = String(block.heading == null ? '' : block.heading);
        const headingWhere = heading ? where + ' · "' + heading + '"' : where;
        if (block.type === 'fields') {
            out.push({
                type: 'fields', heading,
                style: resolveCellStyles(block.style, heading, FIELDS_BLOCK_CELLS, (m) => warnings.push(headingWhere + ': ' + m)),
                rows: fieldRows(block.fields, node, warnings, headingWhere, context),
            });
            continue;
        }
        if (block.type !== 'collection') continue;   // a later format may add types; an old host stays quiet
        const at = resolvePanelPath(block.path, node, context);
        const child = at.found ? unwrapTupleValue(at.value) : undefined;
        const blockStyle = resolveCellStyles(block.style, heading, COLLECTION_BLOCK_CELLS, (m) => warnings.push(headingWhere + ': ' + m));
        // The heading paint travels with the BLOCK; each group takes only the groupKey half, judged
        // against its own key rather than the heading.
        const headingStyle = blockStyle.heading ? { heading: blockStyle.heading } : {};
        if (!child || typeof child !== 'object' || Array.isArray(child)) {
            if (!at.found) {
                const w = missingPathWarning(headingWhere + ' collection', block.path, at, context && context.ownScopeEmpty);
                if (w) warnings.push(w);
                else if (context && context.suppressed) context.suppressed.count += 1;
            }
            out.push({ type: 'collection', heading, style: headingStyle, groups: [], missing: true });
            continue;
        }
        const hasNested = Array.isArray(block.blocks) && block.blocks.length > 0;
        const canDescend = depth < PANEL_CAPS.depth;
        // ONCE per block, not once per key: a 24-group collection would otherwise say it 24 times.
        if (hasNested && !canDescend) {
            warnings.push(where + ': nested blocks below depth ' + PANEL_CAPS.depth + ' are not rendered');
        }
        const groups = [];
        for (const key of Object.keys(child).slice(0, PANEL_CAPS.groups)) {
            const here = headingWhere + ' · ' + key;
            groups.push({
                key,
                // The heading's own paint, judged against the KEY — the group's only value.
                style: resolveCellStyles(block.style && block.style.groupKey !== undefined ? { groupKey: block.style.groupKey } : undefined,
                    key, GROUP_CELLS, (m) => warnings.push(here + ': ' + m)),
                rows: fieldRows(block.fields, child[key], warnings, here, context),
                blocks: (hasNested && canDescend) ? buildBlocks(block.blocks, child[key], warnings, here, context, depth + 1) : [],
            });
        }
        out.push({ type: 'collection', heading, style: headingStyle, groups, missing: false });
    }
    return out;
}

export function renderSlotModel(declaration, scopeState, context) {
    const warnings = [];
    const model = { title: String((declaration && declaration.title) || ''), tabs: [], warnings };
    // Decided ONCE for the slot, not per tab: it is a fact about the drawer, and a slot with four tabs
    // bound to it would otherwise say the same thing four times.
    const ownScopeEmpty = isOwnScopeEmpty(scopeState);
    const ctx = { ...(context && typeof context === 'object' ? context : {}), ownScopeEmpty, suppressed: { count: 0 } };
    const tabs = Array.isArray(declaration && declaration.tabs) ? declaration.tabs : [];
    for (const tab of tabs.slice(0, PANEL_CAPS.tabs)) {
        if (!tab || typeof tab !== 'object') continue;
        const outTab = { id: String(tab.id || ''), name: String(tab.name || tab.id || ''), blocks: [] };
        outTab.blocks = buildBlocks(tab.blocks, scopeState, warnings, 'tab "' + outTab.name + '"', ctx, 1);
        model.tabs.push(outTab);
    }
    // FIRST in the list, and only if it stood in for something: this line is the CAUSE of the rows it
    // replaced, so a reader meets it before whatever else the slot has to say. A slot that binds
    // nothing to its own drawer never sees it — an empty drawer is not a fault on its own.
    if (ctx.suppressed.count) warnings.unshift(emptyOwnScopeWarning(ctx.suppressed.count));
    return model;
}

// ── the renderPanel engine hook (its shape is PINNED here) ──────────────────
//
// A resolver may export `renderPanel(ctx)` to COMPUTE its view instead of binding it. The host calls
// it with `{ ownState, snapshot, engine, exposes }` — the relay's read-side ctx without the turn
// fields (`ops`, `mid`, `swipe`): a render is not a turn and must not look like one. It returns DATA
// in the block vocabulary above, with VALUES already computed (it had the state in hand — paths
// would only make the host walk the same tree twice):
//   { title?, tabs: [{ id, name, blocks: [
//       { type: 'fields', heading?, style?, rows: [{ label, value, style? }] } |
//       { type: 'collection', heading?, style?, groups: [{ key, style?, rows, blocks? }] } ] }] }
// A computed collection paints `groupKey` on each GROUP (`groups[].style`), since the hook builds every
// group itself; a declaration paints it on the block, judged per key. Markup is never accepted — every
// value renders as text. This normalizer is the whole contract: anything outside it is dropped, the
// caps above apply the same as to a bound declaration, and a paint or a nesting the caps refuse is
// reported into `warnings` exactly as the bound lane reports it (the host logs each once per chat),
// placed behind `renderPanel` so the author knows which lane said it. Returns null for anything
// unusable, and the host then renders the bound declaration.
export function normalizeRenderedPanel(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const warnings = [];
    const norm = { title: String(data.title || ''), tabs: [], warnings };
    const complainAt = (where) => (m) => warnings.push(where + ': ' + m);
    const rowsOf = (rows, where) => (Array.isArray(rows) ? rows : []).slice(0, PANEL_CAPS.rows)
        .filter((r) => r && typeof r === 'object')
        .map((r) => {
            const label = String(r.label == null ? '' : r.label);
            return {
                label, value: displayValue(r.value), missing: false,
                // The hook names cells like a declaration does, and every colour goes through the same
                // hex check. No CSS but a colour literal reaches a style property through this door.
                style: resolveCellStyles(r.style, r.value, ROW_CELLS, (m) => warnings.push(where + ' — "' + label + '": ' + m)),
            };
        });
    // The SAME recursion the bound lane has: a hook may nest its groups too, and one shape means one
    // DOM builder. Depth is capped here as well — a hook is not a way around the caps.
    const blocksOf = (blocks, where, depth) => {
        const out = [];
        for (const block of (Array.isArray(blocks) ? blocks : []).slice(0, PANEL_CAPS.blocks)) {
            if (!block || typeof block !== 'object') continue;
            const heading = String(block.heading == null ? '' : block.heading);
            const headingWhere = heading ? where + ' · "' + heading + '"' : where;
            const style = resolveCellStyles(block.style, heading, FIELDS_BLOCK_CELLS, complainAt(headingWhere));
            if (block.type === 'fields') {
                out.push({ type: 'fields', heading, style, rows: rowsOf(block.rows, headingWhere) });
                continue;
            }
            if (block.type !== 'collection') continue;
            const groupList = (Array.isArray(block.groups) ? block.groups : []).slice(0, PANEL_CAPS.groups)
                .filter((g) => g && typeof g === 'object');
            const canDescend = depth < PANEL_CAPS.depth;
            // ONCE per block, not once per group — the same sentence the bound lane prints.
            if (!canDescend && groupList.some((g) => Array.isArray(g.blocks) && g.blocks.length > 0)) {
                warnings.push(where + ': nested blocks below depth ' + PANEL_CAPS.depth + ' are not rendered');
            }
            const groups = groupList.map((g) => {
                const key = String(g.key == null ? '' : g.key);
                const here = headingWhere + ' · ' + key;
                return {
                    key,
                    style: resolveCellStyles(g.style, g.key, GROUP_CELLS, complainAt(here)),
                    rows: rowsOf(g.rows, here),
                    blocks: canDescend ? blocksOf(g.blocks, here, depth + 1) : [],
                };
            });
            out.push({ type: 'collection', heading, style, groups, missing: false });
        }
        return out;
    };
    for (const tab of (Array.isArray(data.tabs) ? data.tabs : []).slice(0, PANEL_CAPS.tabs)) {
        if (!tab || typeof tab !== 'object') continue;
        const name = String(tab.name || tab.id || '');
        norm.tabs.push({ id: String(tab.id || ''), name, blocks: blocksOf(tab.blocks, 'renderPanel tab "' + name + '"', 1) });
    }
    return norm.tabs.length ? norm : null;
}

