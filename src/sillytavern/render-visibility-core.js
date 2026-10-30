// sillytavern/render-visibility-core.js — WHO is hiding a rendered frontend block? v0.1
//
// The decision half of the render-visibility watchdog, pure so it tests without a DOM (L6). The
// host half walks a rendered iframe's real ancestors and hands the styles here; this file only
// answers: is anything in that chain hiding the block, and what is the first thing that does?
//
// WHY "first": ancestors are given innermost-first, so the first hiding entry is the NEAREST
// enclosing element that kills the block — the one to name in the log. Anything above it may also
// be hidden, but the nearest one is where the hunt starts. (Live 2026-09-02: a StatusMenu built
// 620 KB of DOM inside a display:none <details> another extension's regex had drawn around it and
// then hidden — hours of hunting that one console line would have ended.)
//
// Deliberately NOT here: any notion of which block is "ours", any extension's class names, any
// expectation about what the chain should look like. The check reads computed style and nothing
// else, so it cannot rot when SillyTavern or TavernHelper change their wrapping — the exact trap
// that killed the "assert direct child of .mes_text" design this replaced.

// TH-message--<messageId>--<blockIndex> with an optional _<n> streaming suffix — the shape
// TavernHelper's own util.ts parses. Anything else (TH-script-- frames, foreign emits) is not a
// message render and returns null.
export function parseMessageIdFromIframeName(name) {
    const m = String(name == null ? '' : name).match(/^TH-message--(\d+)--\d+(_\d+)?$/);
    return m ? Number(m[1]) : null;
}

// One ancestor's computed style → why it hides its subtree, or null when it does not.
// display:none and visibility:hidden/collapse are the only ways an ANCESTOR makes a descendant
// invisible through style; opacity and clipping still lay the box out and are somebody's design.
export function hidingReason(style) {
    const s = style || {};
    if (s.display === 'none') return 'display:none';
    if (s.visibility === 'hidden' || s.visibility === 'collapse') return 'visibility:' + s.visibility;
    return null;
}

// 'details.custom-meg-blocks-src' — enough to grep the culprit, capped so a utility-class soup
// stays readable.
export function nodeLabel(entry) {
    const e = entry || {};
    const tag = String(e.tag || '?').toLowerCase();
    const classes = String(e.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
    return classes.length ? tag + '.' + classes.join('.') : tag;
}

// The verdict. chain = [{tag, className, display, visibility}, ...] innermost-first, as far up as
// the host chose to walk. Returns the first hiding entry as {index, label, reason}, or null when
// the whole chain is visible. Junk in → null out: a chain we cannot read is not evidence of hiding.
export function findHiddenAncestor(chain) {
    if (!Array.isArray(chain)) return null;
    for (let i = 0; i < chain.length; i++) {
        const entry = chain[i];
        if (!entry || typeof entry !== 'object') continue;
        const reason = hidingReason(entry);
        if (reason) return { index: i, label: nodeLabel(entry), reason };
    }
    return null;
}
