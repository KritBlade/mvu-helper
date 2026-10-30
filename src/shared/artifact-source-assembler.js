// shared/artifact-source-assembler.js — artifact SOURCE FOLDER -> the pack object (authority §28, W2).
//
// THE one assembler. The `npm run dev` loop (workflow plan W3) and the folder import (authority G5)
// both call THIS, by invariant (workflow plan §4.1): two code paths would mean a developer debugs an
// artifact that is not the one that ships, and the difference surfaces on someone else's machine.
// School v4's `Schoolv4/Tools/assemble_workspace.cjs` is the throwaway third copy that predates this
// module; it retires against this one (its own header says so).
//
// PURE — no host imports, no I/O, no logging. The caller owns the filesystem (the dev server reads
// disk, the import lane reads a folder upload) and hands in [{path, text}] with forward-slash paths
// relative to the ARTIFACT folder root. Errors and warnings return as data; the caller logs them.
//
// WHAT IS DELIBERATELY *NOT* HERE: pack VALIDATION. This module maps structure to sections and
// refuses only what is wrong AS SOURCE — a sidecar with no `.txt`, an engine member `engineOrder`
// does not name. Whether the assembled object is a legal pack of its declared type is §3's table,
// consulted where validation already reads it (`validatePack`), never restated here (authority
// §28.1). Run the assembled pack through the validator; a `layout/` directory under a gamelogic
// pack errors THERE, as "section layout on the wrong type".
//
// Sidecar contract (authority §28.2): a sidecar IS a TavernHelper `LorebookEntry` minus `content`.
// Assembly is `{ ...sidecar, content: <the .txt> }` — nothing renamed, nothing defaulted.

// The directories this format defines. Anything else at the top level is an ERROR, never a silent
// skip: a developer who invents `lorebooks/` must be told nothing reads it (authority §28.1 — genre
// material lives BESIDE the artifact folder, not inside it). Dot-prefixed names are tooling residue
// (.gitkeep, .DS_Store) and are ignored. README files (README.txt / README.md, any depth) are
// ignored the same way — documentation FOR the developer, read by nothing (§28.1; the W8 skeletons
// ship them to say a folder's file is a placeholder, e.g. that a layout is authored in the builder).
const SECTION_DIRECTORIES = ['engine', 'entries', 'events', 'layout', 'panel', 'regex', 'schema'];

// Sidecar keys refused with the reason each has exactly ONE honest source (authority §28.2).
const REFUSED_SIDECAR_KEYS = {
    content: 'the content is the .txt beside it — two sources for one value',
    uid: 'a uid is the SOURCE book\'s identity; carrying one into a destination book can collide',
    display_index: 'display_index is the SOURCE book\'s identity, stripped on install',
};

// `constant: true` is the trap, not a spelling: TavernHelper silently DROPS the boolean, leaving
// `type: "selective"` with no keys — an entry SillyTavern then never injects at all.
const BOOLEAN_TYPE_KEYS = ['constant', 'selective', 'vectorized'];

const normalize = (text) => String(text ?? '').replace(/\r\n/g, '\n');
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const isDotPath = (p) => p.split('/').some((part) => part.startsWith('.'));
const isReadmePath = (p) => /^readme[.](txt|md)$/i.test(baseName(p));

// files: [{path, text}], paths relative to the artifact folder root, forward slashes.
// Returns { pack, errors, warnings, orderListing }. `pack` is null when errors made assembly
// meaningless (no pack.json / unparseable pack.json); otherwise it is complete minus the failed
// pieces, so ONE run reports every problem rather than the first.
export function assembleArtifactSource(files) {
    const errors = [];
    const warnings = [];
    const byPath = new Map();
    for (const f of Array.isArray(files) ? files : []) {
        const p = String(f.path).replace(/\\/g, '/').replace(/^\.?\//, '');
        if (isDotPath(p) || isReadmePath(p)) continue;
        byPath.set(p, normalize(f.text));
    }

    const parseJson = (path) => {
        try {
            return JSON.parse(byPath.get(path));
        } catch (e) {
            errors.push(path + ' is not valid JSON: ' + e.message);
            return null;
        }
    };

    // ── pack.json — identity + the declarations with no file content ─────────
    if (!byPath.has('pack.json')) {
        return { pack: null, errors: ['no pack.json at the artifact folder root — nothing identifies this artifact'], warnings, orderListing: [] };
    }
    const declared = parseJson('pack.json');
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
        if (declared !== null) errors.push('pack.json must be a JSON object');
        return { pack: null, errors, warnings, orderListing: [] };
    }
    // `engineOrder` is a SOURCE-FORM key (authority §28.3): consumed here, never emitted — on the
    // assembled pack it would only trip §3's unknown-top-level-key warning.
    const { engineOrder, ...pack } = declared;

    // ── the top level: pack.json plus the section directories, nothing else ──
    const topLevel = new Map(); // first segment -> one example path
    for (const p of byPath.keys()) {
        if (p === 'pack.json') continue;
        const slash = p.indexOf('/');
        if (slash < 0) {
            errors.push('unexpected file at the artifact folder root: "' + p + '" — only pack.json lives there');
            continue;
        }
        const dir = p.slice(0, slash);
        if (!SECTION_DIRECTORIES.includes(dir)) {
            if (!topLevel.has(dir)) errors.push('unknown directory "' + dir + '/" — this format defines ' + SECTION_DIRECTORIES.map((d) => d + '/').join(' ') + '; genre material belongs BESIDE the artifact folder, not inside it');
        }
        topLevel.set(dir, p);
    }

    const inDir = (dir) => [...byPath.keys()].filter((p) => p.startsWith(dir + '/')).sort();

    // ── engine/ — concatenated in engineOrder, two-way checked (§28.3) ───────
    const engineFiles = inDir('engine');
    if (engineFiles.length || Array.isArray(engineOrder)) {
        const order = Array.isArray(engineOrder) ? engineOrder.map(String) : [];
        if (!Array.isArray(engineOrder)) {
            errors.push('engine/ holds ' + engineFiles.length + ' file(s) but pack.json declares no engineOrder — the concatenation is a dependency chain and must be declared');
        }
        const present = new Set(engineFiles.map(baseName));
        for (const name of order) {
            if (!present.has(name)) errors.push('engineOrder names "' + name + '", which is not in engine/');
        }
        for (const name of present) {
            if (!order.includes(name)) errors.push('engine/' + name + ' is not named in engineOrder — it would silently never be concatenated');
        }
        if (!errors.length || order.every((n) => present.has(n))) {
            const parts = order.filter((n) => present.has(n)).map((n) => byPath.get('engine/' + n));
            parts.forEach((text, i) => {
                if (i < parts.length - 1 && text && !text.endsWith('\n')) {
                    warnings.push('engine/' + order[i] + ' does not end with a newline — its last line and the next member\'s first line would merge');
                }
            });
            if (parts.length) pack.engine = parts.join('');
        }
    }

    // ── entries/ — one entry per .txt/.json PAIR, subdirectories allowed (§28.2) ──
    const entryFiles = inDir('entries');
    const stems = new Map(); // stem path -> {txt, json}
    for (const p of entryFiles) {
        const m = /\.(txt|json)$/.exec(p);
        if (!m) {
            errors.push(p + ' is neither a .txt nor a .json — nothing in an entries/ tree can ship it');
            continue;
        }
        const stem = p.slice(0, -m[1].length - 1);
        if (!stems.has(stem)) stems.set(stem, {});
        stems.get(stem)[m[1]] = p;
    }
    const entries = [];
    for (const [stem, pair] of [...stems.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (!pair.json) { errors.push(stem + '.txt has no .json sidecar'); continue; }
        if (!pair.txt) { errors.push(stem + '.json has no .txt beside it'); continue; }
        const sidecar = parseJson(pair.json);
        if (sidecar === null) continue;
        if (typeof sidecar !== 'object' || Array.isArray(sidecar)) {
            errors.push(pair.json + ' must be a JSON object (a LorebookEntry minus content)');
            continue;
        }
        let bad = false;
        for (const [key, why] of Object.entries(REFUSED_SIDECAR_KEYS)) {
            if (key in sidecar) { errors.push(pair.json + ' carries "' + key + '" — ' + why); bad = true; }
        }
        for (const key of BOOLEAN_TYPE_KEYS) {
            if (typeof sidecar[key] === 'boolean') {
                errors.push(pair.json + ' carries a boolean "' + key + '" — TavernHelper drops it silently and the entry never injects; say type: "' + key + '"');
                bad = true;
            }
        }
        if (!bad) entries.push({ ...sidecar, content: byPath.get(pair.txt), __sourcePath: stem });
    }
    if (entries.length) {
        // __sourcePath exists only for the order listing below; the pack carries clean entries.
        pack.entries = entries.map(({ __sourcePath, ...entry }) => entry);
    }

    // ── layout/ — exactly layout.json (StatusMenu Packs) ─────────────────────
    const layoutFiles = inDir('layout');
    for (const p of layoutFiles) {
        if (p !== 'layout/layout.json') errors.push('layout/ holds "' + baseName(p) + '" — the one file this format reads there is layout.json');
    }
    if (layoutFiles.includes('layout/layout.json')) {
        const layout = parseJson('layout/layout.json');
        if (layout !== null) pack.layout = layout;
    }

    // ── panel/ — exactly panel.json (GameLogic Plugins; plans/executed/plugin-sidepanel.md §3) ──
    // Its own directory rather than a pack.json key because it may grow a locale/ sibling (workflow
    // §2.6); until that day the directory holds one file, and anything else there is named.
    const panelFiles = inDir('panel');
    for (const p of panelFiles) {
        if (p !== 'panel/panel.json') errors.push('panel/ holds "' + baseName(p) + '" — the one file this format reads there is panel.json');
    }
    if (panelFiles.includes('panel/panel.json')) {
        const panel = parseJson('panel/panel.json');
        if (panel !== null) pack.panel = panel;
    }

    // ── events/ — one event-pack UPLOAD FILE per file, carried verbatim ──────
    // Read as opaque text, never parsed here. The format is the event-pack feature's (a hidden
    // <mvueventpack> block plus its gated prose bodies), and this assembler runs in NODE for the dev
    // server — importing that feature to parse a file here would drag its host-coupled barrel into a
    // pure module. So the file's own identity, its row count and every syntax refusal come from the
    // install lane, which already reads exactly this text when a developer pastes one.
    //
    // Sub-folders are FLATTENED: `inDir` matches at any depth, so events/ may be organised however a
    // route wants. Nothing keys on the name — it is a label for error lines — so two files sharing a
    // basename in different folders is not a collision.
    const eventFiles = inDir('events');
    if (eventFiles.length) {
        pack.events = eventFiles.map((p) => ({ name: p.slice('events/'.length), text: byPath.get(p) }));
    }

    // ── regex/ — one regex object per JSON file; regex-order.json is the ORDER, not a regex ───
    // Regexes execute in list order (W9, §2.8): `regex-order.json`, when present, is an array of
    // script_names that becomes the pack's `regexOrder` section, and the objects are sorted by it —
    // listed names in declared order, unlisted after in filename order. Completeness is rule 14's
    // (§3's table home), not restated here; the sort tolerates the incomplete case only so ONE run
    // reports every problem instead of crashing before the validator can name them.
    const REGEX_ORDER_FILE = 'regex/regex-order.json';
    const regexFiles = inDir('regex').filter((p) => p !== REGEX_ORDER_FILE);
    const regex = [];
    for (const p of regexFiles) {
        if (!p.endsWith('.json')) { errors.push(p + ' is not a .json — a regex/ file is one regex object'); continue; }
        const obj = parseJson(p);
        if (obj !== null) regex.push(obj);
    }
    if (byPath.has(REGEX_ORDER_FILE)) {
        const order = parseJson(REGEX_ORDER_FILE);
        if (order !== null) {
            if (!Array.isArray(order) || order.some((n) => typeof n !== 'string')) {
                errors.push(REGEX_ORDER_FILE + ' must be a JSON array of script_name strings — it declares the pack\'s regex apply order');
            } else {
                pack.regexOrder = order;
                const at = new Map(order.map((n, i) => [n, i]));
                regex.sort((a, b) => {
                    const ia = at.has(String((a && a.script_name) || '')) ? at.get(String(a.script_name)) : order.length;
                    const ib = at.has(String((b && b.script_name) || '')) ? at.get(String(b.script_name)) : order.length;
                    return ia - ib;   // stable sort: unlisted names keep their filename order after the listed
                });
            }
        }
    }
    if (regex.length) pack.regex = regex;

    // ── schema/ — the one Zod registration script ────────────────────────────
    const schemaFiles = inDir('schema');
    if (schemaFiles.length > 1) {
        errors.push('schema/ holds ' + schemaFiles.length + ' files — the schema is ONE registration script, and two cannot both be it: ' + schemaFiles.map(baseName).join(', '));
    } else if (schemaFiles.length === 1) {
        pack.schema = byPath.get(schemaFiles[0]);
    }

    // ── the order table, DERIVED — the gate prints it so nobody authors it ───
    const orderListing = entries
        .map((e) => ({ order: e.order ?? null, type: e.type ?? null, enabled: e.enabled !== false, comment: String(e.comment || ''), path: e.__sourcePath }))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.comment < b.comment ? -1 : 1));

    return { pack, errors, warnings, orderListing };
}

// Workspace detection (workflow plan §2.1): a pack.json AT the chosen root means one artifact;
// otherwise every immediate subdirectory holding a pack.json is one. Mechanical, no flag, no
// manifest. Returns [{ name, files }] with each artifact's files re-rooted to its own folder;
// `name` is '' for the single-artifact case. Subdirectories WITHOUT a pack.json are simply not
// artifacts — the workspace root is not validated, because the artifact folders are.
export function splitWorkspaceSources(files) {
    const list = (Array.isArray(files) ? files : []).map((f) => ({ path: String(f.path).replace(/\\/g, '/').replace(/^\.?\//, ''), text: f.text }));
    if (list.some((f) => f.path === 'pack.json')) return [{ name: '', files: list }];
    const artifacts = new Map();
    for (const f of list) {
        const slash = f.path.indexOf('/');
        if (slash < 0) continue;
        const dir = f.path.slice(0, slash);
        if (!artifacts.has(dir)) artifacts.set(dir, []);
        artifacts.get(dir).push({ path: f.path.slice(slash + 1), text: f.text });
    }
    return [...artifacts.entries()]
        .filter(([, inner]) => inner.some((f) => f.path === 'pack.json'))
        .map(([name, inner]) => ({ name, files: inner }));
}

// Uploaded trees carry the container the developer POINTED AT: a directory pick prefixes every path
// with the picked folder's own name, and a zip made by right-clicking a folder wraps everything in
// that folder. Neither container is source. Strip single common top directories until artifacts are
// findable — pure normalization, no guessing: stripping stops the moment splitWorkspaceSources can
// answer, never continues past a top-level FILE, and a tree that never yields an artifact comes
// back unchanged so the caller's "no pack.json" error names what the user actually gave it.
export function normalizeWorkspaceRoot(files) {
    let list = (Array.isArray(files) ? files : []).map((f) => ({ path: String(f.path).replace(/\\/g, '/').replace(/^\.?\//, ''), text: f.text }));
    for (let depth = 0; depth < 8; depth++) {
        if (splitWorkspaceSources(list).length > 0) return list;
        const tops = new Set(list.map((f) => f.path.split('/')[0]));
        if (tops.size !== 1) return list;
        const [top] = tops;
        if (list.some((f) => f.path === top)) return list;   // a top-level FILE, not a container
        list = list.map((f) => ({ path: f.path.slice(top.length + 1), text: f.text }));
    }
    return list;
}
