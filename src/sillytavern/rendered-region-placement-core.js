// sillytavern/rendered-region-placement-core.js — is one of OUR rendered regions still where we put it?
//
// The decision half of the placement guard, pure so it tests without a DOM (L6). The host half walks
// a region's real ancestors and hands the labels here; this file only answers: is anything standing
// between our region and its owner, and is that worth moving out of.
//
// WHAT IT IS ABOUT, and the reason it names nothing. A message is rendered from TEXT: SillyTavern
// runs the regex chain, hands the result to a markdown pass, and an HTML parser builds the tree. A
// parser has no way to reject an element that never closes — it supplies the closing tag at end of
// input. So one unclosed tag anywhere in a reply silently adopts everything after it, and a region
// that is LAST is adopted with certainty. Measured live 2026-09-03: a preset had the model author
// its own collapsible block, the model emitted one more opener than closer, and the StatusMenu — put
// last on purpose by the marker-last rule — rendered inside it at 150px instead of 948.
//
// This file knows none of that. It does not know which tag, which extension, or which preset; those
// change and the next one will look different. It knows one thing that does not change: a region we
// emitted belongs to the container we emitted it into, and anything that ended up in between is not
// ours.
//
// WHY "ENCLOSED" IS A RELIABLE SIGNAL AND NOT A GUESS. The marker-last rule already moves our
// placeholder to end-of-string before the menu regex consumes it, so any wrapper that CLOSES is
// escaped at the text stage — by the time our row runs, its closing tag is already behind us. What
// survives to the DOM stage is therefore a wrapper that never closed, and an unclosed wrapper is
// nobody's intent. That is what makes "enclosed ⇒ move" exact rather than a heuristic: a card author
// cannot deliberately nest our region, because the text rule would have pulled it back out.
//
// COST, and why the gate is the point. Moving an element that contains an iframe RELOADS that
// iframe, and a StatusMenu is ~200 KB that then re-initialises. So the common case must cost
// nothing: a correctly placed region is one parent comparison and no walk at all.

// Everything standing between a region and its owner. Given the ancestor labels the host collected
// (innermost first, owner excluded), this is simply that list — it exists as a named concept because
// the LOG needs it and because an empty list is the whole of the healthy case.
export function enclosingLabels(betweenLabels) {
    return Array.isArray(betweenLabels) ? betweenLabels.filter((l) => typeof l === 'string' && l) : [];
}

// The verdict.
//
// `hasOwner` false means the region is not inside a container we recognise — a body-level region
// (the side panel mounts as a direct child of <body>) or a detached subtree mid-render. Neither is a
// placement fault and neither may be moved: a region with no owner has nowhere correct to go, and
// guessing one is exactly the kind of expectation that rots.
export function placementVerdict({ hasOwner, betweenLabels } = {}) {
    if (!hasOwner) return { restore: false, reason: 'no owner container — not a message region' };
    const between = enclosingLabels(betweenLabels);
    if (!between.length) return { restore: false, reason: 'already a direct child of its owner' };
    return { restore: true, reason: 'enclosed by ' + between.length + ' foreign element' + (between.length === 1 ? '' : 's') + ': ' + between.join(' < ') };
}

// One move per render is expected: the next render rebuilds the message from the same text and
// encloses the region again, so the guard fires again. What is NOT expected is many moves inside one
// render, which would mean the move itself is re-triggering the signal — a loop in a render handler,
// the worst place to have one. This bounds it and the host WARNS when the bound trips, so a loop
// announces itself instead of heating a fan.
export const MAX_RESTORES_PER_RENDER_CYCLE = 3;

export function restoreAllowed(countSoFar) {
    return Number(countSoFar || 0) < MAX_RESTORES_PER_RENDER_CYCLE;
}
