// sillytavern/tavern-script-core.js — PURE TavernHelper-script-tree helpers (zero imports, zero globals),
// so they load under vitest. The I/O glue that calls getScriptTrees/updateScriptTreesWith lives in
// sillytavern/tavern-script.js and delegates every DECISION here (mirrors the lorebook.js ↔ lorebook-core.js
// and extra-llm-calls.js ↔ extra-llm-calls-core.js splits).
//
// WHY A CORE AT ALL — the tree is not a list. TavernHelper returns a ScriptTree[], where each node is either
// a Script (`type:'script'`) or a ScriptFolder (`type:'folder'`) that CONTAINS more scripts (verified,
// @types/function/script.d.ts). So "find the script named X" and "write X back" are recursive operations
// whose off-by-one failures are invisible from the host file — exactly the L6 case for extracting them.
//
// Shape reference (script.d.ts): Script = { type:'script', enabled, name, id, content, info, button, data,
// export_with }; ScriptFolder = { type:'folder', enabled, name, id, icon, color, scripts: Script[] }.

// Every Script in a tree, folders flattened away, in tree order. Folder nodes themselves are NOT returned —
// callers want scripts. A non-array input, or nodes of an unknown `type`, yield [] / are skipped rather than
// throwing: this reads data owned by another extension, which may add node kinds we do not know.
export function flattenScriptTree(trees) {
    const out = [];
    const walk = (nodes) => {
        if (!Array.isArray(nodes)) return;
        for (const node of nodes) {
            if (!node || typeof node !== 'object') continue;
            if (node.type === 'folder') { walk(node.scripts); continue; }
            if (node.type === 'script') out.push(node);
        }
    };
    walk(trees);
    return out;
}

// Every Script in a tree with whether TavernHelper RUNS it: the script is enabled AND so is every folder
// around it (TavernHelper skips a disabled folder's scripts whatever their own flag says). The scope's own
// switch — "global scripts on", "this card's scripts allowed" — is not part of the tree, so it is not here.
// Returns [{ script, isEnabled }] in tree order.
export function flattenScriptTreeWithEnablement(trees) {
    const out = [];
    const walk = (nodes, isFolderEnabled) => {
        if (!Array.isArray(nodes)) return;
        for (const node of nodes) {
            if (!node || typeof node !== 'object') continue;
            if (node.type === 'folder') { walk(node.scripts, isFolderEnabled && node.enabled !== false); continue; }
            if (node.type === 'script') out.push({ script: node, isEnabled: isFolderEnabled && node.enabled !== false });
        }
    };
    walk(trees, true);
    return out;
}

// The first Script whose `name` matches EXACTLY (case-sensitive), or null. Case-sensitive on purpose: these
// names are a contract with the card author ('mvu', 'Scheme' — the names School v4 ships), and silently
// matching 'MVU' would let two scripts that ST treats as different both claim to be the one we manage.
export function findScriptByName(trees, name) {
    const wanted = String(name || '');
    if (!wanted) return null;
    return flattenScriptTree(trees).find((s) => String(s.name || '') === wanted) || null;
}

// Upsert a script BY NAME into a tree, returning a NEW tree (the input is never mutated — updateScriptTreesWith
// hands us the live array, and mutating it in place would make a failed write half-applied).
//
// Update MERGES onto the existing node, preserving its `id` and every field we do not set — a script carries
// `button`, `data` and `export_with` that belong to whoever created it, and dropping them on a content update
// would silently delete a card's script buttons. Create appends at TOP level (never inside a folder, which is
// the user's organisation, not ours) with the fields TavernHelper requires.
//
// Returns { trees, created }. `id` for a created script comes from the caller (the host file supplies one, so
// this stays pure and deterministic under test).
export function upsertScriptInTree(trees, script, newId) {
    const name = String((script && script.name) || '');
    if (!name) return { trees: Array.isArray(trees) ? trees : [], created: false };
    const list = Array.isArray(trees) ? trees : [];
    let found = false;

    const mapNodes = (nodes) => nodes.map((node) => {
        if (!node || typeof node !== 'object') return node;
        if (node.type === 'folder') return { ...node, scripts: mapNodes(Array.isArray(node.scripts) ? node.scripts : []) };
        if (node.type === 'script' && String(node.name || '') === name) {
            found = true;
            return { ...node, ...script, id: node.id };   // id is the node's own identity — never overwritten
        }
        return node;
    });

    const mapped = mapNodes(list);
    if (found) return { trees: mapped, created: false };
    return {
        trees: [...mapped, {
            type: 'script',
            enabled: true,
            name,
            id: String(newId || ''),
            content: '',
            info: '',
            button: { enabled: false, buttons: [] },
            data: {},
            export_with: { data: false, button: false },
            ...script,
        }],
        created: true,
    };
}

// Remove every script with this exact name, returning { trees, removed } (count). Folders are walked but never
// removed themselves — an emptied folder is the user's to delete, not ours.
export function removeScriptFromTree(trees, name) {
    const wanted = String(name || '');
    if (!wanted) return { trees: Array.isArray(trees) ? trees : [], removed: 0 };
    let removed = 0;
    const filterNodes = (nodes) => nodes.reduce((acc, node) => {
        if (!node || typeof node !== 'object') { acc.push(node); return acc; }
        if (node.type === 'folder') {
            acc.push({ ...node, scripts: filterNodes(Array.isArray(node.scripts) ? node.scripts : []) });
            return acc;
        }
        if (node.type === 'script' && String(node.name || '') === wanted) { removed++; return acc; }
        acc.push(node);
        return acc;
    }, []);
    return { trees: filterNodes(Array.isArray(trees) ? trees : []), removed };
}

// Set `enabled` on the scripts with these ids, returning a NEW tree plus the names actually changed (already-
// at-value scripts are not counted — the caller's log must say what CHANGED, not what was looked at). By id,
// not name: names can repeat across folders, and this flips exactly the nodes a scan identified. Folders are
// never touched — a folder's enabled flag is the user's organisation, not ours.
export function setScriptsEnabledById(trees, ids, enabled) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map((i) => String(i || '')).filter(Boolean));
    const changed = [];
    const on = Boolean(enabled);
    const mapNodes = (nodes) => nodes.map((node) => {
        if (!node || typeof node !== 'object') return node;
        if (node.type === 'folder') return { ...node, scripts: mapNodes(Array.isArray(node.scripts) ? node.scripts : []) };
        if (node.type === 'script' && wanted.has(String(node.id || '')) && (node.enabled !== false) !== on) {
            changed.push(String(node.name || ''));
            return { ...node, enabled: on };
        }
        return node;
    });
    return { trees: mapNodes(Array.isArray(trees) ? trees : []), changed };
}
