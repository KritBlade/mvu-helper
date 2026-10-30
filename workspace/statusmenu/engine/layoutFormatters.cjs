// layoutFormatters.cjs — the formatters this menu's layout computes, EMPTY here because a
// blank pack has no layout yet. MVU Status Menu Builder writes the real one from the layout's
// cell formulas, and its "Refresh layout .zip" replaces this file whole, together with
// layout/layout.json. Never write in it: a formatter written by hand goes in
// statusMenuLogic.cjs, in HAND_FORMATTERS.
//
// It defines ONE name, LAYOUT_FORMATTERS, and loads before statusMenuLogic.cjs (pack.json
// engineOrder). The two files run as one script: a name declared at the top level of both is
// a SyntaxError that stops the whole engine loading.
const LAYOUT_FORMATTERS = {};
