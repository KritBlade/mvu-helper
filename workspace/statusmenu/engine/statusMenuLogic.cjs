// test-status-menu StatusMenu Engine
//
// The engine DECLARES its own identity and exports it. mvu-helper reads these off the
// running module, and reads these same lines when checking a pack that is not loaded
// yet — one source, two readers, so nothing can drift. They must be STRING LITERALS:
// a computed value cannot be read back from source. Bump ENGINE_VERSION on every change;
// it is reported and logged, never compared.
const ENGINE_VERSION = 'v0.1.0';
//
// The display half: formatters read, actions write, nothing else. Formatters are
// (stat, root, scopePath) => value and PURE — `stat` is the raw subtree at `scopePath`,
// the path the menu scoped the cell to (a collection item's own path, `<list>.<key>`),
// and `root` the whole stat_data. Actions are (args, root) => patches. The layout may only
// name what is exported here; an export nothing names is reported as dead code.
//
// The formatters the layout's cells compute are NOT written here: they live in
// layoutFormatters.cjs, which loads before this file (pack.json engineOrder), and arrive as
// LAYOUT_FORMATTERS. This file is yours — no layout export ever replaces it.

// Formatters written by hand, beside the layout's. A name the layout also computes is refused
// when the engine loads: two definitions of one cell's formatter would leave one of them
// silently dead.
const HAND_FORMATTERS = {
};
for (const name of Object.keys(HAND_FORMATTERS)) {
    if (Object.prototype.hasOwnProperty.call(LAYOUT_FORMATTERS, name)) {
        throw new Error('formatter "' + name + '" is written by hand in statusMenuLogic.cjs AND computed by the layout (layoutFormatters.cjs) — rename the hand-written one');
    }
}

module.exports = {
    ENGINE_VERSION,
    formatters: { ...LAYOUT_FORMATTERS, ...HAND_FORMATTERS },
    actions: {},
};
