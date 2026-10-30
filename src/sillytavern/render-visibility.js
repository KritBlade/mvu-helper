// sillytavern/render-visibility.js — say WHO hid a rendered frontend block, the moment it happens. v0.2
//
// WHY IT EXISTS: a StatusMenu (or any TavernHelper-rendered block) can build perfectly — regexes
// fired, iframe loaded, script ran — and still show nothing, because some OTHER element between it
// and the message swallowed it: a regex-drawn wrapper another extension then hides, a stylesheet
// rule, a post-render DOM pass. The text pipeline cannot see any of that, and nothing in ST says a
// word. The player sees a missing menu; the console sees a healthy render. (Live 2026-09-02: hours
// spent finding a display:none <details> drawn by another extension's runaway regex.)
//
// WHAT IT DOES: when a message iframe finishes rendering, walk the REAL ancestor chain from that
// iframe up to its .mes_text and warn with the nearest element whose computed style hides it.
// Computed style sees stylesheet rules that no HTML inspection can. Observation only — it moves
// nothing, unhides nothing (fixing another extension's region is that extension's business, L7).
//
// TWO CALLERS, ONE CHECK. TavernHelper's `message_iframe_render_ended` names ITS frames; the contained
// StatusMenu frame is mvu-helper's own (features/statusmenu-pack/statusmenu-frame.js) and calls
// `checkFrameVisibility` on its frame's load, because no TavernHelper event ever fires for it.
//
// THE BOUNDARY: the walk stops at .mes_text (inclusive). Hiding ABOVE it — .mes_block, .mes, the
// chat — is legitimate message display management (collapsed floors, an overlay mode hiding other
// messages) and would drown the signal in false alarms. A block that lives OUTSIDE .mes_text walks
// up to but excluding its .mes for the same reason.
//
// WHAT IT CANNOT SEE, stated so nobody trusts it further than it goes: a hide applied AFTER the
// iframe's load event fires only re-enters this check on the next re-render; and a block deleted
// outright never fires the render event at all, so deletion is invisible here by construction.
//
// WHY IT IS NOT IN A FEATURE FOLDER: same argument as reply-integrity — nothing here is product
// behaviour, it names no consumer vocabulary, and it must not inherit any feature's gates. It
// watches every message iframe, not just the menu's, because "which block is ours" is exactly the
// kind of expectation that rots; a hidden block is worth one line whoever owns it.
import { eventSource, event_types } from '../../../../../../script.js';
import { createModuleLog } from './log.js';
import { parseMessageIdFromIframeName, findHiddenAncestor, nodeLabel } from './render-visibility-core.js';

const log = createModuleLog('render-visibility');

// TavernHelper's public render events (JS-Slash-Runner src/function/event.ts) — emitted through
// ST's own eventSource, so no TH import is needed. ENDED fires on the iframe's load, after the
// message-rendered handlers that do the hiding have already run.
const TH_RENDER_ENDED = 'message_iframe_render_ended';

// One warn per (message, culprit) until the chat changes — a swipe re-renders the same iframe and
// the same standing defect must not print a second identical line.
const warnedCulprits = new Map();

export function wireRenderVisibility() {
    if (!eventSource) return;
    eventSource.on(TH_RENDER_ENDED, (iframeName) => {
        try {
            checkRenderedIframe(String(iframeName || ''));
        } catch (e) {
            log.warn('check failed for "' + iframeName + '":', e);
        }
    });
    if (event_types && event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => warnedCulprits.clear());
    }
}

function checkRenderedIframe(iframeName) {
    const messageId = parseMessageIdFromIframeName(iframeName);
    if (messageId == null) return; // TH-script-- frame or foreign emit — not a message render
    const frame = document.getElementById(iframeName);
    if (!frame) return; // unmounted between load and this event — nothing left to measure
    checkFrameVisibility(frame, messageId, iframeName);
}

// The check itself, on ANY frame element: the chain from the frame to its .mes_text, and the nearest
// hider named once per (message, culprit). `label` is how the frame is named in the line — the
// TavernHelper iframe's name, or the contained frame's fixed label.
export function checkFrameVisibility(frame, messageId, label) {
    const mes = frame.closest('.mes');
    if (!mes) return; // detached subtree — measuring computed style there reads all-defaults and lies
    const mesText = frame.closest('.mes_text');

    // The chain: the iframe itself first (a rule can hide iframes directly), then each ancestor,
    // bounded per the header — .mes_text inclusive when inside it, otherwise up to .mes exclusive.
    const chain = [];
    let node = frame;
    while (node && node !== mes) {
        const style = window.getComputedStyle(node);
        chain.push({ tag: node.tagName, className: node.className, display: style.display, visibility: style.visibility });
        if (node === mesText) break;
        node = node.parentElement;
    }

    const hidden = findHiddenAncestor(chain);
    if (!hidden) {
        log.verbose('' + label + ' visible (chain of ' + chain.length + ' clear)');
        return;
    }

    const seen = warnedCulprits.get(messageId) || new Set();
    const key = hidden.label + '|' + hidden.reason;
    if (seen.has(key)) return;
    seen.add(key);
    warnedCulprits.set(messageId, seen);

    const where = hidden.index === 0 ? 'the iframe itself' : '<' + hidden.label + '>, ' + hidden.index + ' level' + (hidden.index === 1 ? '' : 's') + ' above it';
    log.warn('' + label + ' on message ' + messageId + ' rendered but is INVISIBLE — '
        + where + ' carries ' + hidden.reason + '. The block built fine; the element hiding it is not ours. '
        + 'Chain (innermost first): ' + chain.map(nodeLabel).join(' > '));
}
