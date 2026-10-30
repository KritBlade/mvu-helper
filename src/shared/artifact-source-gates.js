// shared/artifact-source-gates.js — the generic source gates (workflow plan §7, W5). Pure.
//
// The assembler (artifact-source-assembler.js) refuses what is wrong AS SOURCE — a sidecar with no
// .txt, an engine member engineOrder does not name. These gates refuse what is wrong AS CONTENT:
// things that assemble cleanly, install cleanly, and then lie at runtime. Each one exists because
// something shipped broken first (§7's table names the incidents); they run on every dev-loop save,
// so the failure lands while the developer still remembers what they changed.
//
// PLATFORM-SIDE ONLY (L1): no gate here reads a route token, a genre name, or a consumer state
// path. The line that keeps G-B honest: mvu-helper knows that CONSTANT entries all render in the
// main prompt — its own assembly — but cannot know which SELECTIVE entries co-fire, because that
// grouping is consumer routing. School keeps its own pass-aware scanner for that half
// (Schoolv4/Tools/scan_ejs_scope.cjs, which is also where the parsing below is ported from).
//
// Pure: assembled pack (and, for a menu, its engine's exports — read by the caller in a Worker) in,
// { errors, warnings } out. No I/O, no host imports, no logging, and no engine text is ever RUN here —
// the dev server merges the result into the artifact's error list, and the import lane calls the same
// function (§4.1: one implementation, every consumer).

import { declaredNameOf } from './engine-header.js';

// ── EJS scriptlet extraction (G-A/G-B share it) ──────────────────────────────
// Scriptlets only — `<%=` output tags hold expressions, not statements, and cannot declare.
const SCRIPTLET_RE = /<%_?(?!=)([\s\S]*?)_?%>/g;

function scriptletBodies(text) {
    const bodies = [];
    let m;
    const re = new RegExp(SCRIPTLET_RE.source, 'g');
    while ((m = re.exec(String(text)))) bodies.push(m[1]);
    return bodies;
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// The comma-separated declarator identifiers of one let/const/var statement starting just after
// the keyword. Skips initializers (respecting (), [], {}, and strings) and collects the identifier
// that begins each declarator. Ported from School's proven scanner — mechanism, not vocabulary.
function parseDeclarators(code, start) {
    const names = [];
    let i = start, depth = 0, expectName = true;
    while (i < code.length) {
        const ch = code[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            const q = ch; i++;
            while (i < code.length && code[i] !== q) { if (code.charCodeAt(i) === 92) i++; i++; }
            i++; expectName = false; continue;
        }
        if ('([{'.includes(ch)) { depth++; i++; expectName = false; continue; }
        if (')]}'.includes(ch)) { if (depth === 0) break; depth--; i++; continue; }
        if (ch === ';') { i++; break; }
        if (depth === 0 && ch === ',') { expectName = true; i++; continue; }
        if (expectName && /[A-Za-z_$]/.test(ch)) {
            let j = i; while (j < code.length && /[A-Za-z0-9_$]/.test(code[j])) j++;
            names.push(code.slice(i, j)); i = j; expectName = false; continue;
        }
        i++;
    }
    return { names, end: i };
}

// Every identifier an entry declares with let/const/var at brace-depth 0 across its scriptlets —
// the names that land in the ONE compile scope ST-Prompt-Template builds per render pass.
export function depthZeroDeclarations(entryText) {
    const top = new Set();
    let depth = 0;
    for (const raw of scriptletBodies(entryText)) {
        const code = stripComments(raw);
        const kw = /\b(?:let|const|var)\s+/g;
        let dm;
        while ((dm = kw.exec(code))) {
            let dd = depth;
            for (let k = 0; k < dm.index; k++) { const ch = code[k]; if (ch === '{') dd++; else if (ch === '}') dd--; }
            if (dd !== 0) continue;
            const { names, end } = parseDeclarators(code, dm.index + dm[0].length);
            for (const n of names) top.add(n);
            kw.lastIndex = end;
        }
        for (const ch of code) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    }
    return [...top].sort();
}

// ── G-A: every EJS entry's scriptlets COMPILE as one scope ───────────────────
// A scriptlet that throws at compile time ships the ENTIRE entry to the model as raw, unrendered
// template text — which still reads like prose, so every branch of it lies and nothing looks
// broken (School live 2026-08-22: a duplicate `const bandIdx` inside one entry's try block).
// Compile only, never execute: undefined helpers (getvar, sd) are irrelevant to syntax. Wrapped
// async because entries legally await.
function gateEntrySyntax(entries, errors) {
    for (const entry of entries) {
        const content = String(entry.content || '');
        if (!content.includes('<%')) continue;
        const bodies = scriptletBodies(content);
        if (!bodies.length) continue;
        try {
            new Function('async function __syntaxProbe() {\n' + bodies.join('\n') + '\n}');
        } catch (e) {
            errors.push('entry "' + entry.comment + '": its EJS scriptlets do not compile as one scope — '
                + String(e && e.message) + '. The entry would reach the model as RAW template text, which '
                + 'still reads like prose while every branch of it lies.');
        }
    }
}

// ── G-B: no two CONSTANT entries declare the same depth-0 name ───────────────
// ST-Prompt-Template concatenates every entry rendered in one pass into ONE EJS compile scope, so
// a shared depth-0 `let` throws `Identifier 'X' has already been declared` and the whole pass
// ships raw (School live 2026-07-11 `_present`, 2026-07-29 `_engineMissing`). Constant entries all
// render in the MAIN prompt — the one pass this platform itself assembles — so that bucket is
// checkable here with zero routing knowledge. Which SELECTIVE entries co-fire is consumer routing,
// and that half stays in the consumer's own scanner.
function gateConstantCollisions(entries, errors) {
    const byName = new Map();   // name -> [comment]
    for (const entry of entries) {
        if (entry.type !== 'constant' || entry.enabled === false) continue;
        const content = String(entry.content || '');
        if (!content.includes('<%')) continue;
        for (const name of depthZeroDeclarations(content)) {
            if (!byName.has(name)) byName.set(name, []);
            byName.get(name).push(String(entry.comment));
        }
    }
    for (const [name, comments] of [...byName.entries()].sort()) {
        if (comments.length < 2) continue;
        errors.push('depth-0 "' + name + '" is declared by ' + comments.length + ' constant entries ('
            + comments.join(', ') + ') — they render in the SAME pass, the duplicate declaration throws at '
            + 'compile time, and the whole pass ships as raw template text. Rename one side.');
    }
}

// ── G-C: every formatter AND action the layout names is exported by the engine beside it ─
// §3.5: the builder cannot run this check in the lane that matters — at refresh its export carries
// no engine at all, and the real one is the hand-written workspace file it must never read. Here
// layout and REAL engine sit side by side, the only place the check measures what it claims to.
//
// The layout walk is shape-blind: any object carrying a `formatters` key whose value is a map of
// field -> name declares those names, wherever it sits. No tabs/blocks/cards vocabulary — the cell
// grammar belongs to the renderer, not to this gate.
export function declaredFormatterNames(layout) {
    const sites = new Map();   // name -> first path that names it
    const walk = (node, path) => {
        if (!node || typeof node !== 'object') return;
        const map = node.formatters;
        if (map && typeof map === 'object' && !Array.isArray(map)) {
            for (const name of Object.values(map)) {
                if (typeof name === 'string' && name.trim() && !sites.has(name.trim())) sites.set(name.trim(), path);
            }
        }
        for (const key of Object.keys(node)) walk(node[key], path ? path + '.' + key : key);
    };
    walk(layout, '');
    return sites;
}

// The ACTIONS a layout names — the write half's collector (B5 step 1's ActionButton cell), the same
// shape-blind walk: any object carrying a string `action` names an engine action. A click on such a
// cell posts that name to the dispatcher, which refuses an unknown one by name (§9.4) — so a layout
// naming an action the engine beside it lacks is a button that can never do anything.
export function declaredActionNames(layout) {
    const sites = new Map();   // name -> first path that names it
    const walk = (node, path) => {
        if (!node || typeof node !== 'object') return;
        if (typeof node.action === 'string' && node.action.trim() && !sites.has(node.action.trim())) sites.set(node.action.trim(), path);
        for (const key of Object.keys(node)) walk(node[key], path ? path + '.' + key : key);
    };
    walk(layout, '');
    return sites;
}

// The engine's exports can only be learned by RUNNING it, and this module never runs one: the text is
// untrusted (a picked ZIP, a shared card), so its exports arrive as INPUT — `menuEngineExports` on
// gateArtifactSource — read by whoever calls. On the page that is the engine frame's throwaway Worker
// (logic-engine readMenuEngineExportsInWorker); in the Node dev server it is the developer's own process
// (tools/menu-engine-exports-in-process.mjs). Both run the text through the engine Worker's own load
// (createEngineWorkerRuntime) and hand its scope report to the converter below, so the two cannot
// disagree about what a text exports.
//
// Which text needs reading: a menu's (it names formatters and actions) that ships an engine. null when
// there is nothing to read — a pack with no layout, or a menu legally running before its engine exists.
export function menuEngineTextToRead(pack) {
    if (!pack || typeof pack !== 'object' || pack.layout === undefined) return null;
    if (typeof pack.engine !== 'string' || !pack.engine.trim()) return null;
    return pack.engine;
}

// A scope's load report ({ nestedExports, error } — createEngineWorkerRuntime's `loaded` shape) as the
// coverage gate's input: the FUNCTION exports one level under `formatters` and `actions`, which is
// exactly what the Worker can call (resolveScopeExport), so a non-function there counts as missing.
export function menuEngineExportsFromScope(scope) {
    const report = scope || {};
    if (report.error) return { ok: false, error: String(report.error), formatters: [], actions: [] };
    const nested = Array.isArray(report.nestedExports) ? report.nestedExports : [];
    const under = (namespace) => nested.filter((name) => name.startsWith(namespace + '.')).map((name) => name.slice(namespace.length + 1));
    return { ok: true, error: '', formatters: under('formatters'), actions: under('actions') };
}

function gateFormatterCoverage(pack, menuEngineExports, errors, warnings) {
    if (menuEngineTextToRead(pack) === null) return;
    if (!menuEngineExports || typeof menuEngineExports !== 'object') {
        // A caller that skipped the read is a defect in mvu-helper, not in the pack — loud, never a pass.
        throw new Error('gateArtifactSource: this menu ships an engine, so the caller must read its exports first '
            + '(menuEngineExports) — on the page with readMenuEngineExportsInWorker, never by running the text here');
    }
    const declared = declaredFormatterNames(pack.layout);
    const engine = menuEngineExports;
    if (!engine.ok) {
        errors.push('the StatusMenu Engine failed to load: ' + engine.error
            + ' — no formatter can answer until it loads (the engine Worker will hit the same failure)');
        return;
    }
    const exported = new Set(engine.formatters);
    for (const [name, path] of declared) {
        if (!exported.has(name)) {
            errors.push('the layout names formatter "' + name + '" (' + (path || 'layout root') + ') but the '
                + 'engine beside it does not export it — that cell would silently show its raw binding forever');
        }
    }
    for (const name of engine.formatters) {
        if (!declared.has(name)) {
            warnings.push('the engine exports formatter "' + name + '" but no cell in the layout names it — '
                + 'dead code, or a cell lost its binding');
        }
    }
    // Actions: the layout's buttons must find their export. The reverse is NOT dead code — the
    // renderer's own row buttons (delete, equip…) invoke actions no layout cell names — so an
    // unreferenced action is never warned about.
    const exportedActions = new Set(engine.actions);
    for (const [name, path] of declaredActionNames(pack.layout)) {
        if (!exportedActions.has(name)) {
            errors.push('the layout names action "' + name + '" (' + (path || 'layout root') + ') but the engine '
                + 'beside it does not export it — that button would be refused by name on every click');
        }
    }
}

// ── G-D: the engine text COMPILES ────────────────────────────────────────────
// Compile only (module/exports stay free names) — the "parses" half of §7's "engine parses and
// loads in the Worker". The loads half stays live: the dev loop's apply restarts the Worker and
// reports its own failure. Every engine kind gets this; no engine is ever EXECUTED here — G-C's
// reading of a StatusMenu engine happens in a Worker, before this module is called.
function gateEngineCompiles(pack, errors) {
    if (typeof pack.engine !== 'string' || !pack.engine.trim()) return;
    try {
        new Function(pack.engine);
    } catch (e) {
        errors.push('the engine text does not compile: ' + String(e && e.message)
            + ' — the Worker would refuse the same text after install');
    }
}

// ── G-E: Engine-Name header ──────────────────────────────────────────────────
// WARN, not error: absent ⇒ null is the documented-legal state (engine-header.js — plugins fall
// back to prose on an unnamed engine, never guess). The workspace is where adding the line costs
// one save, so the nudge lives here.
//
// ONLY a GameLogic Pack is nudged, because only a GAME engine's name is ever READ: it becomes the
// `engine.name` a plugin resolver branches on in §24. A StatusMenu engine's name and a PLUGIN
// engine's name are read by nobody and stored nowhere, so the declaration would be one nobody
// consults — which is what this gate is for, in reverse. (The plugin half was measured 2026-08-29:
// every plugin engine in the tree drew this warning, lane-probe's included.)
//
// Reads the DECLARATION, not a header line: this text is not running, so it cannot be asked, but the
// const it declares is the same one the loaded engine reports — one source, two readers.
function gateEngineName(pack, warnings) {
    if (pack.packType !== 'gamelogic') return;
    if (typeof pack.engine !== 'string' || !pack.engine.trim()) return;
    if (declaredNameOf(pack.engine) === null) {
        warnings.push('the engine declares no `const ENGINE_NAME` — plugins that branch on the '
            + 'engine name will fall back to prose (§24); one declaration, exported, names it');
    }
}

// ── G-F: the layout's own scope is the pack's declared id ─────────────────────────
// A StatusMenu layout bakes the pack id TWICE — every CSS rule under `[data-pack="<id>"]`, every static
// locale key under `pack.<id>.` — while the RENDERER stamps `registry.activeMenuId`, which install took
// from pack.json's `id`. CSS matching is string equality, so a disagreement matches ZERO elements:
// the pack assembles, installs and renders, and is silently UNSTYLED with every static label reading
// `undefined`. Only the locale half warns at render; the CSS half fails without a sound.
//
// It is a DERIVED COPY of the id — written at EXPORT by the authoring tool, read at RENDER from the
// registry, two writers at two times and nothing comparing them. Live 2026-09-19: School's own menu
// shipped 141 rules and 7 locale keys scoped `statusmenu` while pack.json declared `artifickoi`.
//
// ERROR, not warning: the comparison is string equality and no mismatch is ever legitimate, because
// the renderer stamps one value and only that value can match. And the AUTHORING TOOL cannot check
// it — a browser app never sees the workspace folder, so it cannot read pack.json — which makes the
// assembler the only place the two halves meet.
//
// Platform vocabulary only (L1): `data-pack` and the `pack.<id>.` prefix are this format's own
// scoping conventions, not any genre's.
function gateLayoutScope(pack, errors) {
    const layout = pack.layout;
    if (!layout || typeof layout !== 'object') return;
    const id = typeof pack.id === 'string' ? pack.id.trim() : '';
    // Nothing to compare against. A missing id is the pack rules' finding, and one cause earns one line.
    if (!id) return;

    const foreignCss = new Set();
    const css = typeof layout.globalCss === 'string' ? layout.globalCss : '';
    const re = /data-pack="([^"]*)"/g;
    let m;
    while ((m = re.exec(css))) if (m[1] !== id) foreignCss.add(m[1]);

    const foreignLocale = new Set();
    const locale = layout.staticLocale && typeof layout.staticLocale === 'object' ? layout.staticLocale : {};
    for (const key of Object.keys(locale)) {
        if (!key.startsWith('pack.')) continue;
        const dot = key.indexOf('.', 5);
        if (dot < 0) continue;
        const scope = key.slice(5, dot);
        if (scope !== id) foreignLocale.add(scope);
    }

    const named = (set) => [...set].map((s) => '"' + s + '"').join(', ');
    if (foreignCss.size) {
        errors.push('layout/layout.json scopes its CSS to pack ' + named(foreignCss) + ' but pack.json declares '
            + '"' + id + '" — the renderer stamps the DECLARED id, so every one of those rules matches nothing and '
            + 'the pack ships unstyled. Re-export the layout with id "' + id + '".');
    }
    if (foreignLocale.size) {
        errors.push('layout/layout.json scopes its static locale to pack ' + named(foreignLocale) + ' but pack.json '
            + 'declares "' + id + '" — those keys never reach their base names, so every label that uses one '
            + 'renders "undefined". Re-export the layout with id "' + id + '".');
    }
}

// ── the aggregate the dev server calls ───────────────────────────────────────
// `menuEngineExports` — the menu engine's exports, read by the caller in a Worker (see
// menuEngineTextToRead / menuEngineExportsFromScope above). REQUIRED whenever menuEngineTextToRead(pack)
// returns text; absent then, this throws.
export function gateArtifactSource(pack, { menuEngineExports = null } = {}) {
    const errors = [];
    const warnings = [];
    if (!pack || typeof pack !== 'object') return { errors, warnings };
    const entries = Array.isArray(pack.entries) ? pack.entries : [];
    gateEntrySyntax(entries, errors);
    gateConstantCollisions(entries, errors);
    // Compile first, coverage second: a non-compiling engine would fail BOTH (its load fails too), and
    // one cause must produce one line — the compile error is the cause, so it alone reports.
    const before = errors.length;
    gateEngineCompiles(pack, errors);
    if (errors.length === before) gateFormatterCoverage(pack, menuEngineExports, errors, warnings);
    gateLayoutScope(pack, errors);
    gateEngineName(pack, warnings);
    return { errors, warnings };
}
