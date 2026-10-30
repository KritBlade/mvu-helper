// sillytavern/rendered-region-placement.js — put OUR rendered region back where we emitted it. v0.2
//
// WHY IT EXISTS: a reply is built by an HTML parser, and a parser cannot reject an element that
// never closes — it supplies the closing tag at end of input. One unclosed tag anywhere in a message
// therefore adopts everything after it, and our StatusMenu, placed LAST on purpose by the marker-last
// rule, is adopted with certainty. Live 2026-09-03: a preset had the model author its own collapsible
// block, the model wrote seven openers and six closers, and the menu rendered inside the survivor at
// 150px instead of 948. Nothing was wrong with the menu; only its PARENT was.
//
// WHAT IT DOES: on each rendered region we own, ask whether anything stands between it and the
// container we emitted it into. If something does, move OUR element back — to the position the text
// gave it, directly after whatever adopted it — and nothing else. It does not close anyone's tag,
// rewrite anyone's markup, hide anything or read anyone's content. The foreign element keeps every
// child it legitimately adopted; it simply stops holding ours.
//
// WHY IT NAMES NOTHING: no tag, no extension, no preset. Those change; the next swallow will look
// different. What does not change is that a region we emitted belongs to the container we emitted it
// into. That is the whole rule, and it is why this survives an author we have never heard of.
//
// WHY IT IS NOT A GUESS: marker-last already escapes any wrapper that CLOSES, at the text stage,
// before the menu regex runs. So a region still enclosed at DOM stage is inside something that never
// closed — never anyone's intent. A card author cannot deliberately nest our region; the text rule
// would have pulled it out first. (Detail in the core's header.)
//
// THE COST, and why the gate is the design: moving an element containing an iframe RELOADS that
// iframe, and a menu is ~200 KB that then re-initialises. So the healthy case — every render on
// every well-formed reply — must cost nothing, and does: one parent comparison per region, no walk,
// no computed style, no content read.
//
// TWO CALLERS. TavernHelper's render-ended event, for whatever TavernHelper still renders; and the
// contained StatusMenu frame's host (features/statusmenu-pack/statusmenu-frame.js), which calls
// `restoreEnclosedRegions` BEFORE it appends its frame — the region has to sit in its owner first,
// because moving it afterwards would reload the frame it just mounted.
//
// WHY IT IS NOT IN A FEATURE FOLDER: same argument as render-visibility beside it. Nothing here is
// product behaviour and it names no consumer vocabulary; it acts on whatever carries our published
// region attribute, which today is the menu and tomorrow is whatever else we draw into a message.
//
// RELATION TO render-visibility: that one OBSERVES and never touches (a foreign element hiding its
// own region is that extension's business, L7). This one touches ONE element and only ours. The line
// between them is ownership, not severity.
import { eventSource, event_types } from '../../../../../../script.js';
import { createModuleLog } from './log.js';
import { REGION_ATTRIBUTE, regionSelector } from '../shared/rendered-region.js';
import { placementVerdict, restoreAllowed, MAX_RESTORES_PER_RENDER_CYCLE } from './rendered-region-placement-core.js';

const log = createModuleLog('rendered-region-placement');

// TavernHelper's render-ended signal — the same one render-visibility uses, and for the same reason:
// it fires on the iframe's load, after every handler that reshapes the message has already run.
const TH_RENDER_ENDED = 'message_iframe_render_ended';

// The container a message region belongs to. A region with no such ancestor is not a message region
// (the side panel mounts at body level) and is left alone by placementVerdict's no-owner arm.
const OWNER_SELECTOR = '.mes_text';

// Moves per region since the last chat change, so a move that re-triggers this handler announces
// itself instead of spinning. One move per render is EXPECTED — the next render rebuilds the message
// from the same text and encloses the region again.
const restoreCounts = new Map();

export function wireRenderedRegionPlacement() {
    if (!eventSource) return;
    eventSource.on(TH_RENDER_ENDED, () => {
        try {
            restoreEnclosedRegions();
        } catch (e) {
            log.warn('check failed:', e);
        }
    });
    if (event_types && event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => restoreCounts.clear());
    }
}

// Every region we own, checked. The selector is the published contract's, so this covers whatever we
// draw into a message without being told about it.
export function restoreEnclosedRegions() {
    const regions = document.querySelectorAll(regionSelector());
    for (const region of regions) {
        const owner = region.closest(OWNER_SELECTOR);
        // The GATE. A correctly placed region stops here, having read one property.
        if (owner && region.parentElement === owner) continue;

        const between = [];
        let node = region.parentElement;
        while (node && node !== owner) {
            between.push(node.tagName.toLowerCase());
            node = node.parentElement;
        }

        const verdict = placementVerdict({ hasOwner: !!owner, betweenLabels: between });
        if (!verdict.restore) continue;

        const name = region.getAttribute(REGION_ATTRIBUTE) || '(unnamed)';
        const key = name + '@' + (region.closest('.mes')?.getAttribute('mesid') ?? '?');
        const count = restoreCounts.get(key) || 0;
        if (!restoreAllowed(count)) {
            if (count === MAX_RESTORES_PER_RENDER_CYCLE) {
                restoreCounts.set(key, count + 1);
                log.warn('"' + name + '" has been moved back ' + count + ' times and keeps being '
                    + 'enclosed again — stopping. Something is re-parenting it after we move it, which this guard '
                    + 'cannot win; the region stays where it is.');
            }
            continue;
        }
        restoreCounts.set(key, count + 1);

        // WHERE it goes back. Not appended — that would rescue a region and RELOCATE it in the same
        // move, which is only harmless for a region that belongs last anyway. Inserting it directly
        // after the OUTERMOST element that adopted it restores the position the text actually gave
        // it: everything that adopted us closes, then we follow, exactly as a balanced document would
        // have rendered. It also stops this guard from quietly depending on the marker-last rule.
        let outermost = region.parentElement;
        while (outermost && outermost.parentElement !== owner) outermost = outermost.parentElement;
        owner.insertBefore(region, outermost ? outermost.nextSibling : null);

        log.warn('"' + name + '" was ' + verdict.reason + ' — moved back to its owner. '
            + 'A tag in this reply was opened and never closed, so the parser adopted everything after it, ours '
            + 'included. Only our own element was moved; nothing else in the message was touched. '
            + 'An iframe inside it reloads as a result.');
    }
}
