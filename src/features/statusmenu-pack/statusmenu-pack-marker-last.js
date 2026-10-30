// mvu-helper · statusmenu-pack — the menu marker is the LAST thing in the message TEXT. v0.2
//
// THE INVARIANT. Whatever else a reply's TEXT accumulates, the placeholder ends it. A row installed
// beside the menu's own regex moves the marker to end-of-string; the menu regex then replaces it there.
// TEXT is the whole of the claim — see WHAT IT CANNOT COVER below before reading it as more.
//
// WHY IT IS WORTH ENFORCING. SillyTavern renders a message by running every regex script over the text,
// and any of them may WRAP a span of it in an element. A wrapper that opens before our marker and closes
// after it makes the menu a descendant of a region we do not own — and whoever drew that region is free
// to hide it, taking the menu along. End-of-string is the one position no earlier wrapper can enclose,
// because by the time our row runs that wrapper's closing tag is already in the string.
//
// WHY THE ORDERING HOLDS — public/scripts/extensions/regex/engine.js:
//   export const SCRIPT_TYPES = { GLOBAL: 0, PRESET: 2, SCOPED: 1 };   // "ORDER MATTERS"
//   getRegexScripts() -> Object.values(SCRIPT_TYPES).flatMap(...)      // [0, 2, 1]
// GLOBAL, then PRESET, then SCOPED. Our rows are SCOPED — card-owned — so they read everyone else's
// finished output and get the last edit. Only ST changing that order can break this.
//
// THE FAILURE THAT MOTIVATED IT, measured live 2026-09-02. Megumin Suite V10 is named here as EVIDENCE,
// not as a target: nothing below matches its vocabulary, repairs its output, or changes behaviour when it
// is absent.
//   findRegex : /<Blocks>([\s\S]*?)(?:<\/Blocks\s*>|$)/gi
//   replace   : <details class="meg-blocks-src" open>...$1</details>
// The `|$` branch runs to end of string whenever the model leaves the tag unclosed — routine on a small
// model — so everything past that point became one <details>, which the extension then hid outright. The
// StatusMenu built normally inside it: 620 KB of DOM, its script ran, and the iframe measured 0 even when
// forced to 800px. Nothing in our text was wrong. Only its POSITION was.
//
// WHAT IT CANNOT COVER — last in the REGEX CHAIN is not last to TOUCH THE MESSAGE. The text chain
// finishes, SillyTavern renders, and only then do extensions run their own DOM passes; nothing a regex
// can say reaches that stage. Measured on the same reply: Megumin's regex emits only a HIDDEN source
// element, and its render.js afterwards APPENDS the card a reader actually sees to the end of
// .mes_text — below our menu, whatever this rule did to the text. So a node hidden, moved or removed
// after render, or hidden by a stylesheet rule, is a DOM-stage fault this rule can neither see nor
// reach, and no ordering of regex rows will change that.
//
// COST. Whatever followed the marker in the TEXT renders above the menu now instead of after it —
// including, where the text had put the marker inside a region, outside that region rather than
// within. It reorders nothing that an extension INJECTS after render: that lands wherever its own DOM
// pass puts it. The trade is paid against text-produced content only.

import { MENU_PLACEHOLDER, MARKER_LAST_REGEX_NAME } from './statusmenu-pack-core.js';

// SillyTavern parses find_regex as /pattern/flags, so the marker's own '/' has to arrive escaped. Built
// from MENU_PLACEHOLDER rather than retyped: a second copy of a published contract is a second thing that
// can drift, and drift here compiles to a pattern that silently matches nothing.
const escapeForRegexLiteral = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// The regex ROW installed beside the menu's own. Fields mirror the menu shell exactly — AI output only,
// display not prompt — so it fires in the same pass and on the same text the menu regex sees next.
//
// Deliberately NOT global: exactly one marker exists, and a /g pass over a string it just rewrote is a
// second chance to move something already where it belongs.
//
// script_name is the lifecycle key — regex install, replace and removal all match on it, never on id — and
// the W6 export drops the row by that same name, so it is declared once beside MENU_PLACEHOLDER in core.
export const MARKER_LAST_REGEX = {
    id: 'b7e41c92-0af5-4d63-9e18-2f6a8c05d371',
    script_name: MARKER_LAST_REGEX_NAME,
    enabled: true,
    find_regex: '/' + escapeForRegexLiteral(MENU_PLACEHOLDER) + '([\\s\\S]*)$/i',
    replace_string: '$1' + MENU_PLACEHOLDER,
    trim_strings: [],
    source: { user_input: false, ai_output: true, slash_command: false, world_info: false, reasoning: false },
    destination: { display: true, prompt: false },
    run_on_edit: true,
    min_depth: null,
    max_depth: null,
};

// Install-time composition: this row, then whatever the pack ships. Returns NEW arrays — the pack object
// is compared byte for byte by the artifact drift guard, so mutating it here would fail a test that is
// about something else entirely and send the next reader hunting the assembler.
//
// Order is the entire point: this row must run BEFORE the menu regex consumes the marker.
export function withMarkerLastRow(packRegexes, declaredOrder) {
    const rows = Array.isArray(packRegexes) ? packRegexes : [];
    const names = rows.map((r) => String((r && r.script_name) || ''));
    // Already present (a re-apply meeting our own previous write) — keep one copy, keep it first.
    const without = rows.filter((r) => String((r && r.script_name) || '') !== MARKER_LAST_REGEX.script_name);
    const order = Array.isArray(declaredOrder) && declaredOrder.length
        ? [MARKER_LAST_REGEX.script_name,
            ...declaredOrder.filter((n) => String(n) !== MARKER_LAST_REGEX.script_name)]
        : undefined;
    return { regexes: [MARKER_LAST_REGEX, ...without], declaredOrder: order, wasPresent: names.includes(MARKER_LAST_REGEX.script_name) };
}
