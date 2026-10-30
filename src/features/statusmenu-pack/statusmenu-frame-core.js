// statusmenu-pack/statusmenu-frame-core.js — the PURE half of the contained menu frame
// (plans/executed/statusmenu-containment.md M3–M6): the sandbox tokens, the Content-Security-Policy, the prelude
// the frame runs BEFORE the author's document, the srcdoc composition, the wrapper that keeps the menu
// frame on that document, and the readers for every message the frame and its host exchange. No host
// imports — every decision here is unit-testable; statusmenu-frame.js mounts what this decides, and
// MvuHelper.statusMenuFrameSource() publishes it so a second host (galgame-companion) mounts the SAME
// document rather than a second containment.
//
// WHY A FRAME OF OUR OWN. TavernHelper renders a fenced <html> block into an iframe with NO sandbox
// attribute and hands it the parent's `_`, every TavernHelper function, SillyTavern.getContext() and
// Mvu. That is its contract for card frontends, and nothing outside it can narrow it. The lift (M2)
// takes the document out of TavernHelper's reach; this file is where it lands instead: an opaque
// origin (`sandbox` without allow-same-origin), a CSP the author's script runs UNDER, and a bridge
// that offers exactly what a menu needs and nothing it does not.

// ── the sandbox ──────────────────────────────────────────────────────────────

// Exactly these two tokens. `allow-scripts` because a menu IS script. `allow-modals` because
// `confirm()` gates row actions and `alert()` reports refusals — without it confirm() returns false
// silently and every confirmed action is cancelled. NEVER `allow-same-origin` (the frame would be the
// page again), never `allow-top-navigation`, `allow-popups` or `allow-forms` (nothing submits).
export const MENU_FRAME_SANDBOX = 'allow-scripts allow-modals';

// ── the CSP ──────────────────────────────────────────────────────────────────

// The user's GLOBAL image-source list (D1): CSP source expressions, space-separated. Default: any
// http(s) host — a menu may show external images (D6). `data:` and `blob:` are always added, never
// read from here; SillyTavern's own images arrive as `blob:` through the page (readMenuImageRequest).
export const MENU_IMAGE_SOURCES_SETTING = 'statusmenu_image_sources';
export const MENU_FRAME_IMAGE_SOURCES_DEFAULT = 'http: https:';

// A source expression the CSP grammar accepts as a HOST or SCHEME source: no quotes (so 'self',
// 'unsafe-inline' and friends are refused — 'self' matches NOTHING in an opaque-origin document and
// the others are not image sources), no semicolons (a source can never smuggle a directive).
const IMAGE_SOURCE_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::(?:\d+|\*))?(?:\/[^\s;'"]*)?|https?:\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::(?:\d+|\*))?(?:\/[^\s;'"]*)?)$/i;

// The setting, parsed: what goes into the CSP and what was refused (the UI shows the refusals; the
// CSP never carries them).
export function parseMenuImageSources(setting) {
    const raw = String(setting == null ? MENU_FRAME_IMAGE_SOURCES_DEFAULT : setting).trim();
    const tokens = raw ? raw.split(/\s+/) : [];
    const sources = [];
    const rejected = [];
    for (const token of tokens) (IMAGE_SOURCE_PATTERN.test(token) ? sources : rejected).push(token);
    return { sources, rejected };
}

// One string, every directive named, and why: default nothing; inline script and style because the
// author's document is inline (a nonce would mean rewriting author HTML, and the goal is origin
// isolation, not XSS defence inside the author's own frame); `img-src` is `data:` (the image cache
// stores data URLs), `blob:` (SillyTavern's own images, read through the page — its
// Cross-Origin-Resource-Policy: same-origin drops a direct load from this frame whatever the CSP
// says, so SillyTavern's origin is not listed) and the user's list; everything else 'none'. With no
// host in `script-src`, `<script src>` and dynamic import() are refused from every origin — the same
// rule the engine Worker runs under (logic-engine/engine-frame-core.js).
export function buildMenuFrameCsp({ imageSources } = {}) {
    const { sources } = parseMenuImageSources(imageSources);
    return [
        "default-src 'none'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        ['img-src', 'data:', 'blob:', ...sources].join(' '),
        "connect-src 'none'",
        "font-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
}

// ── when the host pushes state ──────────────────────────────────────────────

// TavernHelper's announcement that `Mvu` now exists: initializeGlobal('Mvu', …) sets the global and
// emits `global_Mvu_initialized` on SillyTavern's eventSource (JS-Slash-Runner src/function/global.ts).
// When a chat opens the menu can be ready BEFORE that — the card's MVU script loads after the chat
// renders — so the push its ready message asks for has no state to send and this event is what fills
// it. The frame's own waitGlobalInitialized('Mvu') cannot wait for it: the prelude answers from the
// state it holds.
export const MENU_MVU_READY_EVENT = 'global_Mvu_initialized';

// ── the wire ─────────────────────────────────────────────────────────────────

// Every message type the frame and its host exchange, beside the three the dispatcher already speaks.
export const MENU_STATE_MESSAGE = 'mvu-helper:statusmenu-state';                    // host → frame: { mid, statData }
export const MENU_FRAME_READY_MESSAGE = 'mvu-helper:statusmenu-ready';              // frame → host: {} — the prelude has run; push the state
export const MENU_FRAME_HEIGHT_MESSAGE = 'mvu-helper:statusmenu-height';            // frame → host: { height }
export const MENU_FRAME_OVERLAY_MESSAGE = 'mvu-helper:statusmenu-overlay';          // frame → host: { open }
export const MENU_FRAME_ERROR_MESSAGE = 'mvu-helper:statusmenu-error';              // frame → host: { message, source, line }
export const MENU_LOREBOOK_CONTENT_MESSAGE = 'mvu-helper:statusmenu-lorebook-content';   // frame → page: { requestId, key } → '-result' { content }
export const MENU_IMAGE_MESSAGE = 'mvu-helper:statusmenu-image';                        // frame → page: { requestId, url } → '-result' { blob } | { reason }
export const MENU_LINK_MESSAGE = 'mvu-helper:statusmenu-link';                          // frame → page: { url } — opened in a new tab; no answer
export const MENU_FRAME_BLOCKED_MESSAGE = 'mvu-helper:statusmenu-blocked';          // wrapper → host: { url }
export const MENU_FRAME_RELOADED_MESSAGE = 'mvu-helper:statusmenu-reloaded';        // wrapper → host: {}

// The host-bound messages, read the way readMenuActionRequest reads: four the prelude sends (ready,
// height, overlay, error) and two the wrapper sends (blocked, reloaded — composeMenuFrameWrapperSrcdoc).
// `mine` separates "not ours" (the window carries SillyTavern's own traffic and every other extension's)
// from "ours and malformed", which is warned, never guessed at.
export function readMenuFrameMessage(message) {
    if (!message || typeof message !== 'object') return { mine: false };
    const type = message.type;
    if (type === MENU_FRAME_READY_MESSAGE) return { mine: true, ok: true, kind: 'ready' };
    if (type === MENU_FRAME_HEIGHT_MESSAGE) {
        const height = Number(message.height);
        if (!Number.isFinite(height) || height < 0) return { mine: true, ok: false, kind: 'height', reason: 'height must be a non-negative number' };
        return { mine: true, ok: true, kind: 'height', height: Math.round(height) };
    }
    if (type === MENU_FRAME_OVERLAY_MESSAGE) {
        if (typeof message.open !== 'boolean') return { mine: true, ok: false, kind: 'overlay', reason: 'open must be a boolean' };
        return { mine: true, ok: true, kind: 'overlay', open: message.open };
    }
    if (type === MENU_FRAME_ERROR_MESSAGE) {
        if (typeof message.message !== 'string') return { mine: true, ok: false, kind: 'error', reason: 'message must be a string' };
        return {
            mine: true, ok: true, kind: 'error',
            message: message.message.slice(0, 2000),
            source: typeof message.source === 'string' ? message.source.slice(0, 300) : '',
            line: Number.isFinite(Number(message.line)) ? Number(message.line) : 0,
        };
    }
    if (type === MENU_FRAME_BLOCKED_MESSAGE) {
        if (typeof message.url !== 'string') return { mine: true, ok: false, kind: 'blocked', reason: 'url must be a string' };
        return { mine: true, ok: true, kind: 'blocked', url: message.url.slice(0, 500) };
    }
    if (type === MENU_FRAME_RELOADED_MESSAGE) return { mine: true, ok: true, kind: 'reloaded' };
    return { mine: false };
}

// What an error a frame reported MEANS, for the one line the host writes about it:
//   'cross-origin'  the document reached for window.parent / top and the contained frame refused —
//                   an export made before MvuStatMenuBuilder 2.5.2, or a hand-written unguarded read;
//   'image'         the prelude's own image rescue could not show a SillyTavern image;
//   'menu'          anything else — a fault in the document itself.
export function menuFrameErrorVerdict({ message, source } = {}) {
    if (source === 'image') return 'image';
    return /SecurityError|cross-origin|Blocked a frame|Permission denied to access/i.test(String(message || '')) ? 'cross-origin' : 'menu';
}

// The mediated lorebook read (D5): one KEY in, one CONTENT out. Refuses a request with no key.
export function readMenuLorebookContentRequest(message) {
    if (!message || typeof message !== 'object' || message.type !== MENU_LOREBOOK_CONTENT_MESSAGE) return { mine: false };
    const requestId = typeof message.requestId === 'string' && message.requestId ? message.requestId : (typeof message.requestId === 'number' ? String(message.requestId) : '');
    if (!requestId) return { mine: true, ok: false, reason: 'no requestId' };
    const key = typeof message.key === 'string' ? message.key.trim() : '';
    if (!key) return { mine: true, ok: false, reason: 'no key', requestId };
    return { mine: true, ok: true, requestId, key };
}

// The mediated SillyTavern IMAGE read. SillyTavern answers every file with
// `Cross-Origin-Resource-Policy: same-origin`, and a contained frame is cross-origin by construction,
// so the browser drops every SillyTavern-hosted image the menu draws — an avatar, a /user/images
// portrait — whatever the CSP allows. The frame asks the page for it instead, by URL; the page fetches
// it same-origin and answers with the bytes. Images only, and only SillyTavern's: the request is
// refused unless the URL resolves to the page's own origin outside `/api/`, and the ANSWER is refused
// unless the response is `image/*` (statusmenu-dispatcher.js checks that half).
export function readMenuImageRequest(message) {
    if (!message || typeof message !== 'object' || message.type !== MENU_IMAGE_MESSAGE) return { mine: false };
    const requestId = typeof message.requestId === 'string' && message.requestId ? message.requestId : '';
    if (!requestId) return { mine: true, ok: false, reason: 'no requestId' };
    if (typeof message.url !== 'string' || !message.url.trim()) return { mine: true, ok: false, reason: 'no url', requestId };
    return { mine: true, ok: true, requestId, url: message.url.trim() };
}

// Where an image request may go: `{ ok, href }` for a SillyTavern-origin GET the page may make on the
// frame's behalf, `{ ok: false, reason }` otherwise. `stOrigin` is the page's origin.
export const MENU_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
export function menuImageRequestProblem(url, stOrigin) {
    let parsed;
    try { parsed = new URL(String(url), String(stOrigin) + '/'); }
    catch (e) { return { ok: false, reason: 'not a URL: ' + (e && e.message) }; }
    if (parsed.origin !== String(stOrigin)) return { ok: false, reason: 'not a SillyTavern URL — the frame loads remote images itself, under its image sources' };
    if (/^\/api(\/|$)/i.test(parsed.pathname)) return { ok: false, reason: 'an API path is not an image' };
    parsed.hash = '';
    return { ok: true, href: parsed.href };
}

// A web link a menu's player clicked. The frame may not open a tab (no allow-popups), and following
// the link inside it would replace the menu with the page, which most sites refuse to be framed as
// anyway. So the prelude hands the page the link's absolute URL and the page opens it in a new tab.
export function readMenuLinkRequest(message) {
    if (!message || typeof message !== 'object' || message.type !== MENU_LINK_MESSAGE) return { mine: false };
    if (typeof message.url !== 'string' || !message.url.trim()) return { mine: true, ok: false, reason: 'no url' };
    return { mine: true, ok: true, url: message.url.trim() };
}

// Whether a frame's `sandbox` attribute is the menu's: the same tokens, in any order. It is how the page
// tells a contained menu frame (its own, or one a second host mounted from statusMenuFrameSource) from
// every other frame on the page.
export function isMenuFrameSandbox(value) {
    if (typeof value !== 'string') return false;
    const tokens = (s) => s.trim().split(/\s+/).filter(Boolean).sort().join(' ');
    return tokens(value) === tokens(MENU_FRAME_SANDBOX);
}

// The menu's window inside a mounted frame: the wrapper's first frame (composeMenuFrameWrapperSrcdoc), or
// null while the wrapper has not made it yet. `frameWindow` is the frame element's contentWindow; its
// `frames.length` and an index below it may be read across origins. An index past the length is not read:
// Safari throws "Sandbox access violation" for it where Chrome answers undefined, and a lazy menu frame
// still offscreen has made no menu frame yet. Only the wrapper's first frame is the menu — a frame the
// menu opens inside itself is not.
export function menuWindowOf(frameWindow) {
    const frames = frameWindow && frameWindow.frames;
    return frames && frames.length > 0 ? frames[0] || null : null;
}

// Which window of a mounted menu frame `source` is. 'frame': the frame element's own window — the
// wrapper, whose relay speaks for the menu (composeMenuFrameWrapperSrcdoc). 'menu': the menu's window
// inside it (menuWindowOf), which reaches the page past the wrapper when it posts to window.top, as the
// builder's formatter, action-inputs and action requests do. null: neither.
export function menuFrameWindowRole(source, frameWindow) {
    if (!source || !frameWindow) return null;
    if (source === frameWindow) return 'frame';
    return menuWindowOf(frameWindow) === source ? 'menu' : null;
}

// Whether the page opens a menu's link: `{ ok, href }` or `{ ok: false, reason }`. Three conditions, each
// a reason of its own:
//   • the asking window is a contained menu frame — the page opens no tab for any other frame, so a
//     frame another extension sandboxed without allow-popups gains no way around its own sandbox here;
//   • the player just clicked (`userActivation` is the page's navigator.userActivation.isActive, which a
//     click inside the frame sets on the page too) — a menu cannot open tabs on its own. null = this
//     browser cannot say, and then no tab opens;
//   • the URL is absolute http(s) — never javascript:, data:, blob: or file:.
export function menuLinkOpenVerdict({ url, isMenuFrame, userActivation } = {}) {
    if (!isMenuFrame) return { ok: false, reason: 'the asking frame is not a contained menu frame — the page opens a tab for a menu only' };
    if (userActivation === null || userActivation === undefined) return { ok: false, reason: 'this browser cannot say whether the player clicked (no navigator.userActivation), so no tab opens' };
    if (userActivation !== true) return { ok: false, reason: 'no click came before it — a menu opens a tab only when the player clicks' };
    let parsed;
    try { parsed = new URL(String(url)); }
    catch (e) { return { ok: false, reason: 'not an absolute URL: ' + (e && e.message) }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'only an http(s) link opens, and this one is ' + parsed.protocol };
    return { ok: true, href: parsed.href };
}

// Whether the page answers a request on its window: `{ isBridge, ok, isSenderGone, reason }`. `bridgeTypes`
// are the requests a menu makes of the page (the dispatcher lists them: lorebook content, image, link,
// formatter, action inputs, action). Each is answered for a contained menu frame only — a window of an
// iframe that carries the menu sandbox (isMenuFrameSandbox), the frame's own or the menu's inside it
// (menuFrameWindowRole), mounted by this host or a second one — and never for another frame or window on
// the page. `isMenuFrame` is a function, asked only for a bridge request, so the rest of the window's
// traffic costs no frame scan. Anything that is not a bridge request is `isBridge: false`, and the
// dispatcher ignores it in silence.
//
// `hasSender` is false when the request arrived with no `source`: the window that posted it was removed
// before the page read it. A menu sits inside its message, and every re-render of the message removes it,
// so a request the menu posted just before is delivered with `source` null (Chrome 155, measured on every
// turn's end). That one is `isSenderGone`: unanswered like any refusal, but a race, not a stranger asking.
export function menuBridgeSenderVerdict(data, { bridgeTypes, hasSender = true, isMenuFrame } = {}) {
    const type = data && typeof data === 'object' ? data.type : undefined;
    const types = bridgeTypes instanceof Set ? bridgeTypes : new Set(Array.isArray(bridgeTypes) ? bridgeTypes : []);
    if (typeof type !== 'string' || !types.has(type)) return { isBridge: false, ok: false, isSenderGone: false, reason: '' };
    if (hasSender === false) {
        return { isBridge: true, ok: false, isSenderGone: true,
            reason: 'its sender no longer exists — the frame was removed after it posted (its message re-rendered, or the chat changed), so nothing can receive the answer to ' + type };
    }
    if (typeof isMenuFrame === 'function' && isMenuFrame() === true) return { isBridge: true, ok: true, isSenderGone: false, reason: '' };
    return { isBridge: true, ok: false, isSenderGone: false, reason: 'the sender is not a contained menu frame — the page answers ' + type + ' for a menu frame only' };
}

// The match the menu's own fetchLorebookContent makes today, page-side: `keys[]` or `comment`,
// trimmed, case-insensitive; the FIRST hit's content, trimmed. Returns null when nothing matches or
// the match has no content. Only the content ever crosses the wire — never another entry's keys,
// comment or uid.
export function lorebookContentByKey(entries, key) {
    const wanted = String(key == null ? '' : key).trim().toLowerCase();
    if (!wanted) return null;
    const list = Array.isArray(entries) ? entries : [];
    const hit = list.find((e) => {
        if (!e || typeof e !== 'object') return false;
        if (Array.isArray(e.keys) && e.keys.some((k) => String(k == null ? '' : k).trim().toLowerCase() === wanted)) return true;
        return typeof e.comment === 'string' && e.comment.trim().toLowerCase() === wanted;
    });
    const content = hit && typeof hit.content === 'string' ? hit.content.trim() : '';
    return content || null;
}

// ── the frame element ────────────────────────────────────────────────────────

// The frame's style at rest, and while an overlay is open (D2, post-and-grow as a LIFT): a popup the
// menu draws `position:fixed; inset:0` covers the FRAME's viewport, so while one is open the host
// makes the frame the page's viewport. Growing the height alone would leave the modal wherever the
// frame happens to sit in the chat scroll. The host saves the inline style it replaces and restores
// it on close; the pure part is the two strings.
//
// A lifted frame also goes into the browser's TOP LAYER (the host shows it as a manual popover). The
// frame sits inside SillyTavern's #sheld and #chat, which are stacking contexts, so no z-index it sets
// can put it above #top-bar or the send form, and a #chat with backdrop-filter is the containing
// block of a fixed child besides. The top layer is above all of that. It is a popover's rendering
// only: the element never moves in the DOM, so the frame does not reload. The lifted style overrides
// the popover defaults (padding, a Canvas background, fit-content size), and 100dvh after 100vh is the
// VISIBLE height where a mobile browser's toolbars take part of 100vh.
export const MENU_FRAME_STYLE = 'width:100%;border:0;display:block;';
export const MENU_FRAME_LIFTED_STYLE = 'position:fixed;inset:0;width:100vw;height:100vh;height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;z-index:99990;';

// What the host does to a frame's lift on one event: 'lift' when an overlay opens on a resting frame,
// 'drop' when it closes on a lifted one, and 'drop' when a lifted frame LOADS again. A reloaded
// document has no overlay open and never says so (its prelude reports only a change), so a lift kept
// across a reload leaves an empty frame over the whole page, above SillyTavern's own bars, taking
// every click. null: nothing to do.
export function menuFrameLiftStep(isLifted, event) {
    if (event === 'overlay-open') return isLifted ? null : 'lift';
    if (event === 'overlay-closed' || event === 'load') return isLifted ? 'drop' : null;
    return null;
}

// ── the prelude ──────────────────────────────────────────────────────────────

// What runs inside the frame BEFORE the author's document, as a classic script. It exists because of
// how a menu is written, not in spite of it: every parent reach in the builder's runtime is behind a
// feature-detect that prefers the frame's OWN window first (`typeof window.waitGlobalInitialized ===
// 'function' ? window : window.parent`), so defining those names in-frame makes the existing code take
// the in-frame branch and never evaluate the `window.parent.<name>` expression that would throw
// (containment §5). The shims answer with the state the host PUSHED; nothing here reaches the page.
//
// The message id is baked in, so `getCurrentMessageId()` answers synchronously from the first line of
// the author's init chain. The stat_data is whatever the host baked (menuFramePrelude; mvu-helper's own
// mounts bake none) until a push replaces it: a builder runtime that finds none skips its first draw and
// subscribes in the same step, so the push draws it whether it lands before or after that step. The
// prelude asks for that push itself: once its inbound listener is in, it posts READY, so the state can
// arrive while the document is still parsing — the frame's `load` waits for every image the menu shows.
//
// Names, and who asks for them (all read off the builder's runtime, rt_*.js):
//   getCurrentMessageId()      rt_mvuConnection resolveCurrentMessageId — asked BEFORE window.name
//   getVariables(context)      rt_mvuConnection refreshFromMvu — SYNC, returns { stat_data }
//   waitGlobalInitialized()    rt_mvuConnection initMvuConnection — the load-bearing one (§5)
//   Mvu.getMvuData(context)    initMvuConnection's initial fetch — SYNC, { stat_data }
//   Mvu.events.VARIABLE_UPDATE_ENDED + eventOn()   the live re-render subscription
//   _.get / _.set              rt_dataHelpers (own window first after B1)
//   localStorage               rt_bindings / rt_modalUi image cache — an in-memory shadow (D3)
//   MvuHelperFrame.lorebookContent(key)   rt_lorebook after B1 — the mediated read (D5)
// and two things no name asks for: every <img> whose src resolves to SillyTavern's origin is read
// through the page and shown from the returned bytes (readMenuImageRequest explains why), and a click on
// an http(s) link is handed to the page, which opens it in a new tab (readMenuLinkRequest explains why).
function menuFramePreludeSource(types) {
    return `(function () {
    'use strict';
    var TYPES = ${JSON.stringify(types)};
    var state = { mid: __MID__, mvuData: __MVU__ };
    var listeners = [];
    var pending = {};
    var seq = 0;
    function post(message) { window.parent.postMessage(message, '*'); }
    function report(message, source) { post({ type: TYPES.error, message: String(message), source: String(source || 'prelude'), line: 0 }); }

    // ── lodash, the two functions the menu uses ──
    function toPath(path) { return Array.isArray(path) ? path.map(String) : String(path == null ? '' : path).split(/[.[\\]]+/).filter(Boolean); }
    function lodashGet(obj, path, def) {
        var cur = obj; var parts = toPath(path);
        for (var i = 0; i < parts.length; i++) { if (cur == null) return def; cur = cur[parts[i]]; }
        return cur === undefined ? def : cur;
    }
    function lodashSet(obj, path, value) {
        if (obj == null || typeof obj !== 'object') return obj;
        var parts = toPath(path); if (!parts.length) return obj;
        var cur = obj;
        for (var i = 0; i < parts.length - 1; i++) {
            var k = parts[i];
            if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = /^\\d+$/.test(parts[i + 1]) ? [] : {};
            cur = cur[k];
        }
        cur[parts[parts.length - 1]] = value;
        return obj;
    }

    // ── the names the menu feature-detects first ──
    window.getCurrentMessageId = function () { return state.mid; };
    window.getVariables = function () { return state.mvuData; };
    window.waitGlobalInitialized = function () { return Promise.resolve(); };
    window.Mvu = { getMvuData: function () { return state.mvuData; }, events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' } };
    window.eventOn = function (name, fn) { if (name === window.Mvu.events.VARIABLE_UPDATE_ENDED && typeof fn === 'function') listeners.push(fn); };
    window._ = { get: lodashGet, set: lodashSet };

    // ── the mediated lorebook read (D5): one key in, one content string out ──
    function lorebookContent(key) {
        return new Promise(function (resolve) {
            var requestId = 'lb' + (++seq) + '-' + Date.now();
            pending[requestId] = resolve;
            post({ type: TYPES.lorebook, requestId: requestId, key: String(key == null ? '' : key) });
            setTimeout(function () { if (pending[requestId]) { delete pending[requestId]; resolve(null); } }, 10000);
        });
    }
    window.MvuHelperFrame = Object.freeze({ version: 1, lorebookContent: lorebookContent, messageId: function () { return state.mid; } });

    // ── localStorage: an in-memory shadow (D3) — the origin is opaque, so the real one throws ──
    var shadow = new Map();
    var storage = {
        getItem: function (k) { return shadow.has(String(k)) ? shadow.get(String(k)) : null; },
        setItem: function (k, v) { shadow.set(String(k), String(v)); },
        removeItem: function (k) { shadow.delete(String(k)); },
        clear: function () { shadow.clear(); },
        key: function (i) { var keys = Array.from(shadow.keys()); return i < keys.length ? keys[i] : null; },
        get length() { return shadow.size; },
    };
    try { Object.defineProperty(window, 'localStorage', { value: storage, configurable: true }); }
    catch (e) { report('localStorage shadow could not be installed: ' + (e && e.message || e)); }

    // ── inbound: the state push, and lorebook answers ──
    window.addEventListener('message', function (event) {
        var data = event && event.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === TYPES.state) {
            if (typeof data.mid === 'number') state.mid = data.mid;
            state.mvuData = { stat_data: data.statData };
            var snapshot = state.mvuData;
            listeners.forEach(function (fn) {
                try { fn(snapshot, snapshot); }
                catch (e) { report('a VARIABLE_UPDATE_ENDED listener threw: ' + (e && e.message || e), 'menu'); }
            });
            return;
        }
        if (data.type === TYPES.lorebook + '-result' && data.requestId && pending[data.requestId]) {
            var resolve = pending[data.requestId];
            delete pending[data.requestId];
            resolve(typeof data.content === 'string' ? data.content : null);
            return;
        }
        if (data.type === TYPES.image + '-result' && data.requestId && pending[data.requestId]) {
            var answer = pending[data.requestId];
            delete pending[data.requestId];
            answer(data.blob instanceof Blob ? data.blob : null, data.reason);
        }
    });
    post({ type: TYPES.ready });

    // ── SillyTavern-hosted images, through the page ──
    // SillyTavern answers every file with Cross-Origin-Resource-Policy: same-origin and this frame is
    // cross-origin, so an <img> pointing at it is dropped by the browser. Each such image is asked of
    // the page by URL and shown from the bytes it returns; remote images load directly, under the CSP.
    var stOrigin = '';
    try { stOrigin = new URL(document.baseURI).origin; } catch (e) { report('the frame has no base URL to resolve SillyTavern images against: ' + (e && e.message || e)); }
    var imageCache = {};
    function requestImage(href) {
        if (!imageCache[href]) {
            imageCache[href] = new Promise(function (resolve) {
                var requestId = 'img' + (++seq) + '-' + Date.now();
                pending[requestId] = function (blob, reason) {
                    if (!blob) { report('SillyTavern image not shown: ' + href + ' — ' + (reason || 'no answer'), 'image'); resolve(null); return; }
                    resolve(URL.createObjectURL(blob));
                };
                post({ type: TYPES.image, requestId: requestId, url: href });
                setTimeout(function () { if (pending[requestId]) { delete pending[requestId]; resolve(null); } }, 15000);
            });
        }
        return imageCache[href];
    }
    function rescueImage(img) {
        var raw = img.getAttribute('src');
        if (!raw || !stOrigin || /^(data|blob):/i.test(raw)) return;
        var href;
        try { href = new URL(raw, document.baseURI).href; }
        catch (e) { return; }   // EXPECTED: a src that is not a URL is not a SillyTavern image; the menu's own <img> shows it as it would anywhere
        if (new URL(href).origin !== stOrigin) return;
        requestImage(href).then(function (objectUrl) {
            if (objectUrl && img.getAttribute('src') === raw) img.setAttribute('src', objectUrl);
        });
    }
    function rescueAll(root) {
        if (root && root.tagName === 'IMG') rescueImage(root);
        if (root && root.querySelectorAll) Array.prototype.forEach.call(root.querySelectorAll('img[src]'), rescueImage);
    }

    // ── links: a web link opens in a new tab, through the page ──
    // Listened for on the window, so it runs after the menu's own handlers: a link the menu handles
    // itself (preventDefault) stays the menu's, and so does an in-page #anchor and any non-web scheme.
    window.addEventListener('click', function (event) {
        if (event.defaultPrevented || event.button !== 0) return;
        var target = event.target;
        var link = target && target.closest ? target.closest('a[href], area[href]') : null;
        if (!link) return;
        var raw = link.getAttribute('href');
        if (!raw || raw.charAt(0) === '#') return;
        var href;
        try { href = new URL(raw, document.baseURI); }
        catch (e) { return; }   // EXPECTED: an href that is not a URL; the browser follows it nowhere either
        if (href.protocol !== 'http:' && href.protocol !== 'https:') return;
        event.preventDefault();
        post({ type: TYPES.link, url: href.href });
    });

    // ── outbound: errors (a dead menu says why), height, overlay ──
    // The thrown value first: an error in a <script type="module"> reaches this event as the bare
    // message "Uncaught ", and only e.error still says what was thrown — a SecurityError there is
    // the one line that tells a pre-fix export from a bug in the menu.
    window.addEventListener('error', function (e) {
        var thrown = e && e.error;
        var text = thrown && (thrown.name || thrown.message) ? String(thrown.name || 'Error') + ': ' + String(thrown.message || '') : String(e && e.message || e);
        post({ type: TYPES.error, message: text, source: String(e && e.filename || ''), line: Number(e && e.lineno || 0) });
    });
    window.addEventListener('unhandledrejection', function (e) {
        var r = e && e.reason;
        post({ type: TYPES.error, message: 'unhandled rejection: ' + String(r && r.message || r), source: '', line: 0 });
    });
    function postHeight() {
        var body = document.body; if (!body) return;
        var h = body.scrollHeight;
        if (h > 0) post({ type: TYPES.height, height: h });
    }
    var overlayOpen = false;
    var overlayCheckQueued = false;
    function overlayNow() {
        var body = document.body; if (!body) return false;
        var w = window.innerWidth, h = window.innerHeight;
        if (!(w > 0 && h > 0)) return false;
        for (var i = 0; i < body.children.length; i++) {
            var el = body.children[i];
            var cs = window.getComputedStyle(el);
            if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
            var r = el.getBoundingClientRect();
            if (r.width >= w * 0.9 && r.height >= h * 0.9) return true;
        }
        return false;
    }
    function checkOverlay() {
        overlayCheckQueued = false;
        var now = overlayNow();
        if (now !== overlayOpen) { overlayOpen = now; post({ type: TYPES.overlay, open: now }); }
    }
    function queueOverlayCheck() {
        if (overlayCheckQueued) return;
        overlayCheckQueued = true;
        window.requestAnimationFrame(checkOverlay);
    }
    document.addEventListener('DOMContentLoaded', function () {
        new ResizeObserver(function () { postHeight(); }).observe(document.body);
        new MutationObserver(queueOverlayCheck).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
        new MutationObserver(function (records) {
            records.forEach(function (rec) {
                if (rec.type === 'attributes') rescueImage(rec.target);
                else Array.prototype.forEach.call(rec.addedNodes, rescueAll);
            });
        }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        rescueAll(document);
        postHeight();
        queueOverlayCheck();
    });
    window.addEventListener('load', postHeight);
})();`;
}

// JSON that is safe inside a <script> element: a "</script" or "<!--" in a stat_data STRING must not
// end our script or open a comment. U+2028/2029 are line terminators to old parsers, escaped too.
function jsonForScript(value) {
    return JSON.stringify(value === undefined ? null : value)
        .replace(/<\//g, '<\\/')
        .replace(/<!--/g, '<\\!--')
        .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
        .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

// The prelude for ONE mount: the message it sits on and that message's MvuData ({ stat_data }) baked
// in. `mid` is what the host read off the region's `.mes[mesid]` ancestor — never the frame's own text.
export function menuFramePrelude({ mid, mvuData } = {}) {
    const id = Number.isFinite(Number(mid)) ? Math.trunc(Number(mid)) : -1;
    const data = mvuData && typeof mvuData === 'object' ? { stat_data: mvuData.stat_data == null ? null : mvuData.stat_data } : { stat_data: null };
    return menuFramePreludeSource({
        state: MENU_STATE_MESSAGE, ready: MENU_FRAME_READY_MESSAGE, height: MENU_FRAME_HEIGHT_MESSAGE, overlay: MENU_FRAME_OVERLAY_MESSAGE,
        error: MENU_FRAME_ERROR_MESSAGE, lorebook: MENU_LOREBOOK_CONTENT_MESSAGE, image: MENU_IMAGE_MESSAGE,
        link: MENU_LINK_MESSAGE,
    })
        .replace('__MID__', String(id))
        .replace('__MVU__', jsonForScript(data));
}

// ── the document ─────────────────────────────────────────────────────────────

const escapeAttribute = (s) => String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));

// The srcdoc, in the order that matters and is tested: our DOCTYPE and head — charset, viewport, the
// CSP `<meta>`, TavernHelper's base style (what every menu is written against: box-sizing, no body
// margin, overflow hidden), the prelude — then the author's document INSIDE our body, exactly as
// TavernHelper nests it (its createSrcContent wraps the fenced block in a document of its own, and the
// parser folds the author's html/head/body into ours). A CSP delivered by `<meta>` governs everything
// parsed after it and author script runs after it, so the author cannot remove it.
export function composeMenuFrameSrcdoc({ csp, prelude, body } = {}) {
    if (typeof csp !== 'string' || !csp) throw new TypeError('statusmenu-frame: composeMenuFrameSrcdoc needs the CSP string');
    if (typeof prelude !== 'string' || !prelude) throw new TypeError('statusmenu-frame: composeMenuFrameSrcdoc needs the prelude');
    if (/<\/script/i.test(prelude)) throw new TypeError('statusmenu-frame: the prelude must not contain </script');
    return [
        '<!DOCTYPE html>',
        '<html>',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        '<meta http-equiv="Content-Security-Policy" content="' + escapeAttribute(csp) + '">',
        '<style>*,*::before,*::after{box-sizing:border-box;}html,body{margin:0!important;padding:0;overflow:hidden!important;max-width:100%!important;}</style>',
        '<script>' + prelude + '</script>',
        '</head>',
        '<body>',
        String(body == null ? '' : body),
        '</body>',
        '</html>',
    ].join('\n');
}

// ── the wrapper ──────────────────────────────────────────────────────────────

// Why the menu's document sits in a frame inside a frame of ours. A CSP delivered with a document
// governs that document and nothing after it: a frame may always navigate itself, and when the menu
// points its frame at another address, the page that arrives has no policy at all — the image-source
// list and connect-src 'none' leave with the document that carried them. Only a frame's PARENT can
// refuse that load, by its own `frame-src`, and the menu frame's parent would be SillyTavern's page,
// where a policy would bind every other extension too. So the frame the host mounts holds this
// wrapper, and the wrapper holds the menu frame. Its one directive is `frame-src 'none'`: the browser
// refuses any address the menu frame is sent to before a request leaves (Chromium measured:
// net::ERR_BLOCKED_BY_CSP, nothing sent), and the menu's own document still loads, because a srcdoc is
// not fetched. Nothing else goes into the wrapper's policy — a srcdoc inherits its parent's, so any
// other directive here would bind the menu too.
//
// The relay carries the menu's own traffic. What the menu posts to its parent goes on to the wrapper's
// parent, so the host hears the menu from the frame it mounted; what anything posts to the wrapper goes
// into the menu — the answers to what the menu asked through it. The relay is in the wrapper's head, so
// it is listening before the menu frame exists and the menu's first message (its READY) gets through.
// The host's state push does not come this way: it is posted to the menu's window directly
// (menuWindowOf), because a message the relay forwards is decoded and encoded again here, and a push
// carries the whole stat_data. Two messages are the wrapper's own, and the relay passes neither type
// from the menu: a load it refused (the host warns, naming the menu), and the menu frame loading again
// by itself — the frame element fires `load` only when the wrapper loads, and a reloaded menu has no
// popup open, so the host drops a lift on every load. A load after a refusal is the browser's error
// page, not the menu, so it is not reported.
export const MENU_WRAPPER_CSP = "frame-src 'none'";

const MENU_WRAPPER_RELAY = `(function () {
    'use strict';
    var BLOCKED = ${JSON.stringify(MENU_FRAME_BLOCKED_MESSAGE)};
    var RELOADED = ${JSON.stringify(MENU_FRAME_RELOADED_MESSAGE)};
    var host = window.parent;
    var refused = false;
    var loads = 0;
    function menu() { var frame = document.querySelector('iframe'); return frame ? frame.contentWindow : null; }
    window.addEventListener('message', function (event) {
        var inner = menu();
        if (!inner) return;
        var ports = Array.prototype.slice.call(event.ports || []);
        if (event.source !== inner) { inner.postMessage(event.data, '*', ports); return; }
        var data = event.data;
        if (data && typeof data === 'object' && (data.type === BLOCKED || data.type === RELOADED)) return;
        host.postMessage(data, '*', ports);
    });
    document.addEventListener('securitypolicyviolation', function (event) {
        if (event.effectiveDirective !== 'frame-src') return;
        refused = true;
        host.postMessage({ type: BLOCKED, url: String(event.blockedURI || '') }, '*');
    });
    document.addEventListener('load', function (event) {
        if (!event.target || event.target.tagName !== 'IFRAME') return;
        loads += 1;
        if (loads > 1 && !refused) host.postMessage({ type: RELOADED }, '*');
    }, true);
})();`;

// The srcdoc of the frame the host mounts: the wrapper's policy and relay, then the menu frame — the
// menu's sandbox, a title for assistive technology, and the menu's own srcdoc (composeMenuFrameSrcdoc)
// as its attribute. The menu frame fills the wrapper; the host sizes and lifts the wrapper's element.
export function composeMenuFrameWrapperSrcdoc({ menuSrcdoc, title } = {}) {
    if (typeof menuSrcdoc !== 'string' || !menuSrcdoc) throw new TypeError('statusmenu-frame: composeMenuFrameWrapperSrcdoc needs the menu srcdoc');
    return [
        '<!DOCTYPE html>',
        '<html>',
        '<head>',
        '<meta charset="utf-8">',
        '<meta http-equiv="Content-Security-Policy" content="' + escapeAttribute(MENU_WRAPPER_CSP) + '">',
        '<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;}iframe{display:block;border:0;width:100%;height:100%;}</style>',
        '<script>' + MENU_WRAPPER_RELAY + '</script>',
        '</head>',
        '<body>',
        '<iframe sandbox="' + MENU_FRAME_SANDBOX + '" title="' + escapeAttribute(title == null ? '' : title) + '" srcdoc="' + escapeAttribute(menuSrcdoc) + '"></iframe>',
        '</body>',
        '</html>',
    ].join('\n');
}

// ── an edit no event announces ───────────────────────────────────────────────
// A variable written OUTSIDE a reply — TavernHelper's variable editor, Mvu.replaceMvuData,
// Mvu.setMvuVariable, updateVariablesWith, a card script — emits nothing a host can listen for. Every
// one of them goes through TavernHelper's replaceVariables, which stores a NEW object in the message's
// variables slot (getVariables hands out a clone), so "has this frame's state changed since its last
// push?" is one reference compare per frame. The host asks on a timer; an unchanged slot is skipped,
// so an idle chat pushes nothing and no menu redraws.
export const MENU_STATE_CHECK_MS = 2000;

// The object a message's current swipe keeps its variables in: the thing an edit replaces. Reads the
// array form and the older keyed-object form alike; null when the message holds no variables.
export function menuStateSlot(message) {
    if (!message || typeof message !== 'object') return null;
    const vars = message.variables;
    if (!vars || typeof vars !== 'object') return null;
    const slot = vars[message.swipe_id != null ? message.swipe_id : 0];
    return slot === undefined ? null : slot;
}

// The frames whose message slot is no longer the one last pushed to them. `entries` carry { mid,
// pushedSlot }; a message that has left the chat is skipped (its frame leaves with it).
export function menuStatesToPush(entries, chat) {
    const due = [];
    for (const entry of (Array.isArray(entries) ? entries : [])) {
        const message = Array.isArray(chat) ? chat[entry.mid] : null;
        if (!message) continue;
        if (menuStateSlot(message) !== entry.pushedSlot) due.push(entry);
    }
    return due;
}

// ── a push the turn's write would undo ───────────────────────────────────────
// The turn's write re-renders its reply, and every menu frame inside goes with the old render; the menu
// mounted in its place asks for its state when it is ready. So a state UPDATE to a menu whose reply that
// write is about to re-render waits for the write, and is sent afterwards only to a menu still there. A
// menu that has just started (READY) holds no state at all, and gets it at once.
export function shouldMenuPushWait({ isMenuStarting, isWriteDue }) {
    return isWriteDue === true && isMenuStarting !== true;
}
