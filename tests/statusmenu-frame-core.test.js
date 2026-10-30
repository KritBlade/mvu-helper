// tests/statusmenu-frame-core.test.js — the contained menu frame's pure half
// (plans/executed/statusmenu-containment.md M3–M6, M8).
//
// What each block guards, and the mutation that proves the guard is one (run by hand, recorded):
//   • the sandbox is EXACTLY two tokens — MUTATION: add allow-same-origin to MENU_FRAME_SANDBOX →
//     the invariant test fails;
//   • the CSP never says 'self' and never lists SillyTavern's origin (its images come through the
//     page); connect-src is 'none';
//   • the SillyTavern image read goes only to SillyTavern's origin, never to /api — MUTATION: drop
//     the origin comparison in menuImageRequestProblem → the evil.example cases pass and the test fails;
//   • the srcdoc order is DOCTYPE → CSP → prelude → author document — MUTATION: swap the prelude and
//     the body in composeMenuFrameSrcdoc → the order test fails;
//   • the prelude defines every name the builder's runtime feature-detects first, and the init chain
//     that runtime runs SURVIVES a window.parent whose every read throws — MUTATION: delete the
//     `window.waitGlobalInitialized =` line from the prelude → the chain test rejects at link one;
//   • the prelude says READY once, after its inbound listener is in, so the push it asks for is heard —
//     MUTATION: post it before the listener → the order test fails; and the host answers READY with a push
//     while a load pushes nothing — MUTATION: call onMenuLoad for 'ready' → the ready test fails;
//   • the mediated lorebook read answers with ONE content string — MUTATION: return the entry → the
//     "content only" test fails;
//   • a web link opens only for a menu frame, only after a click, only for http(s) — MUTATION: drop any
//     one of the three checks in menuLinkOpenVerdict → its refusal test fails; the prelude hands an
//     http(s) click to the page and keeps the menu in place — MUTATION: drop its preventDefault → the
//     click test fails;
//   • the wrapper's policy is `frame-src 'none'` and nothing else — MUTATION: add `script-src 'none'` to
//     MENU_WRAPPER_CSP → the policy test fails (the menu frame would inherit it);
//   • the relay passes the menu's messages out and everything else in, and never the wrapper's own two
//     types from the menu — MUTATION: drop the relay's type check → the "cannot speak as the wrapper" test
//     fails; it reports a frame-src refusal and a reload, not the error page after a refusal — MUTATION:
//     drop `!refused` → the error-page test fails;
//   • the menu's own window speaks for its frame — MUTATION: make menuWindowOf answer the frame's own
//     window → the menuWindowOf test and the 'menu' test fail; and it reads no index past `frames.length`,
//     which Safari throws for — MUTATION: drop the length check → both Safari tests fail;
//   • the host posts every state push to the menu's window, never through the relay — MUTATION: post to
//     entry.frame.contentWindow in pushTo → the push-target test fails;
//   • an update to a menu whose reply the turn's write is about to re-render waits for that write, and
//     READY's push never waits — MUTATION: drop `isMenuStarting !== true` from shouldMenuPushWait → the
//     READY test fails.
//
// What no test here can see: that the frame's origin is really opaque, the parent really unreachable,
// and the wrapper's policy really refuses a load the menu frame starts. Node has no iframe. That is
// Chrome on the deployed build (M9; the wrapper measured 2026-10-26), and Safari as well, with several
// menus mounted and some still offscreen: Safari's cross-origin window throws where Chrome's answers
// undefined (the Safari tests below model the one case measured, 2026-10-27).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    MENU_FRAME_SANDBOX,
    MENU_IMAGE_SOURCES_SETTING, MENU_FRAME_IMAGE_SOURCES_DEFAULT, parseMenuImageSources, buildMenuFrameCsp,
    MENU_STATE_MESSAGE, MENU_FRAME_READY_MESSAGE, MENU_FRAME_HEIGHT_MESSAGE, MENU_FRAME_OVERLAY_MESSAGE, MENU_FRAME_ERROR_MESSAGE, MENU_LOREBOOK_CONTENT_MESSAGE,
    readMenuFrameMessage, readMenuLorebookContentRequest, lorebookContentByKey, menuFrameErrorVerdict,
    MENU_IMAGE_MESSAGE, readMenuImageRequest, menuImageRequestProblem,
    MENU_LINK_MESSAGE, readMenuLinkRequest, isMenuFrameSandbox, menuLinkOpenVerdict,
    MENU_FRAME_STYLE, MENU_FRAME_LIFTED_STYLE, menuFrameLiftStep,
    menuFramePrelude, composeMenuFrameSrcdoc, MENU_MVU_READY_EVENT,
    MENU_FRAME_BLOCKED_MESSAGE, MENU_FRAME_RELOADED_MESSAGE, MENU_WRAPPER_CSP, composeMenuFrameWrapperSrcdoc, menuFrameWindowRole, menuWindowOf,
    MENU_STATE_CHECK_MS, menuStateSlot, menuStatesToPush, shouldMenuPushWait,
} from '../src/features/statusmenu-pack/statusmenu-frame-core.js';

const ST_ORIGIN = 'http://127.0.0.1:8000';

// A window.parent whose EVERY property read throws — what a cross-origin WindowProxy does. `then` is
// answered so an `await` on it does not try to adopt it as a thenable.
function hostileParent() {
    return new Proxy({}, {
        get(_target, prop) {
            if (prop === 'then') return undefined;
            throw new Error('SecurityError: Blocked a frame with origin "null" from accessing a cross-origin frame.');
        },
    });
}

// Run the prelude the way the frame does: a classic script against a window and a document. The
// listeners it installs on DOMContentLoaded never run here (no DOM), which is fine — the names the
// init chain needs are defined synchronously, before the author's first line.
function runPrelude(prelude) {
    const posted = [];
    const window = {
        parent: hostileParent(),
        addEventListener() {},
        requestAnimationFrame() {},
        innerWidth: 0, innerHeight: 0,
    };
    window.parent = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'postMessage') return (m) => posted.push(m);
            if (prop === 'then') return undefined;
            throw new Error('SecurityError: Blocked a frame with origin "null" from accessing a cross-origin frame.');
        },
    });
    const document = { addEventListener() {}, body: null };
    new Function('window', 'document', prelude)(window, document);
    return { window, posted };
}

describe('the sandbox', () => {
    // Every token that would hand the frame a capability the containment exists to remove.
    const FORBIDDEN_SANDBOX_TOKENS = ['allow-same-origin', 'allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-forms', 'allow-downloads'];

    it('is exactly allow-scripts allow-modals — nothing that would make the frame the page again', () => {
        expect(MENU_FRAME_SANDBOX.split(' ').sort()).toEqual(['allow-modals', 'allow-scripts']);
        for (const token of FORBIDDEN_SANDBOX_TOKENS) expect(MENU_FRAME_SANDBOX).not.toContain(token);
    });
});

describe('the CSP', () => {
    it("allows nothing but inline script and style, and images from data:, blob: and the list — never 'self'", () => {
        const csp = buildMenuFrameCsp({ imageSources: '' });
        expect(csp).toContain('img-src data: blob:;');
        expect(csp).not.toContain("'self'");
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("connect-src 'none'");
        expect(csp).toContain("script-src 'unsafe-inline'");
        expect(csp).not.toMatch(/script-src[^;]*http/);
    });
    // SillyTavern sends Cross-Origin-Resource-Policy: same-origin, so listing its origin would advertise
    // a load the browser drops; its images arrive as blob: through the page instead.
    it("does not list SillyTavern's origin — its images come through the page", () => {
        expect(buildMenuFrameCsp({ imageSources: '' })).not.toContain(ST_ORIGIN);
    });
    it('the default lets a menu load images from any http(s) host (D1)', () => {
        expect(MENU_FRAME_IMAGE_SOURCES_DEFAULT).toBe('http: https:');
        expect(buildMenuFrameCsp({})).toContain('img-src data: blob: http: https:');
        expect(MENU_IMAGE_SOURCES_SETTING).toBe('statusmenu_image_sources');
    });
    it('carries only what the setting lists, and refuses what is not a source', () => {
        const { sources, rejected } = parseMenuImageSources("https://cdn.example.com *.imgur.com 'self' evil;connect-src * https:");
        expect(sources).toEqual(['https://cdn.example.com', '*.imgur.com', '*', 'https:']);
        expect(rejected).toEqual(["'self'", 'evil;connect-src']);
        const csp = buildMenuFrameCsp({ imageSources: "https://cdn.example.com 'self'" });
        expect(csp).toContain('img-src data: blob: https://cdn.example.com;');
        expect(csp).not.toContain("'self'");
    });
});

describe('the SillyTavern image read — images only, SillyTavern\'s only', () => {
    it('reads the request: requestId and url required', () => {
        expect(readMenuImageRequest({ type: MENU_IMAGE_MESSAGE, requestId: 'i1', url: ' /user/images/a.png ' })).toEqual({ mine: true, ok: true, requestId: 'i1', url: '/user/images/a.png' });
        expect(readMenuImageRequest({ type: MENU_IMAGE_MESSAGE, requestId: 'i1' }).ok).toBe(false);
        expect(readMenuImageRequest({ type: MENU_IMAGE_MESSAGE, url: '/x.png' }).ok).toBe(false);
        expect(readMenuImageRequest({ type: 'other' }).mine).toBe(false);
    });
    it('MUTATION TARGET — goes only to SillyTavern\'s origin, and never to /api', () => {
        expect(menuImageRequestProblem('/user/images/a.png', ST_ORIGIN)).toEqual({ ok: true, href: ST_ORIGIN + '/user/images/a.png' });
        expect(menuImageRequestProblem(ST_ORIGIN + '/thumbnail?type=avatar&file=x.png#frag', ST_ORIGIN)).toEqual({ ok: true, href: ST_ORIGIN + '/thumbnail?type=avatar&file=x.png' });
        expect(menuImageRequestProblem('https://evil.example/a.png', ST_ORIGIN).ok).toBe(false);
        expect(menuImageRequestProblem('//evil.example/a.png', ST_ORIGIN).ok).toBe(false);
        expect(menuImageRequestProblem('/api/secrets/view', ST_ORIGIN).ok).toBe(false);
        expect(menuImageRequestProblem('/API/settings/get', ST_ORIGIN).ok).toBe(false);
        expect(menuImageRequestProblem('/user/../api/secrets/view', ST_ORIGIN).ok).toBe(false);
    });
    it('the prelude asks for images by the same message type the page answers', () => {
        expect(menuFramePrelude({ mid: 0, mvuData: { stat_data: null } })).toContain(JSON.stringify(MENU_IMAGE_MESSAGE));
    });
});

describe('a web link — opened by the page, in a new tab', () => {
    it('reads the request', () => {
        expect(readMenuLinkRequest({ type: MENU_LINK_MESSAGE, url: ' https://a.example/p.jpg ' })).toEqual({ mine: true, ok: true, url: 'https://a.example/p.jpg' });
        expect(readMenuLinkRequest({ type: MENU_LINK_MESSAGE }).ok).toBe(false);
        expect(readMenuLinkRequest({ type: MENU_LINK_MESSAGE, url: '  ' }).ok).toBe(false);
        expect(readMenuLinkRequest({ type: 'other', url: 'https://a.example/' }).mine).toBe(false);
    });
    it('knows the menu sandbox in any token order, and nothing else', () => {
        expect(isMenuFrameSandbox(MENU_FRAME_SANDBOX)).toBe(true);
        expect(isMenuFrameSandbox(MENU_FRAME_SANDBOX.split(' ').reverse().join('  '))).toBe(true);
        expect(isMenuFrameSandbox('allow-scripts')).toBe(false);
        expect(isMenuFrameSandbox(MENU_FRAME_SANDBOX + ' allow-popups')).toBe(false);
        expect(isMenuFrameSandbox('')).toBe(false);
        expect(isMenuFrameSandbox(null)).toBe(false);
    });
    const clicked = { isMenuFrame: true, userActivation: true };
    it('opens an http(s) link a menu frame asked for right after a click', () => {
        expect(menuLinkOpenVerdict({ ...clicked, url: 'https://raw.example/Image/Profile/Mitsuki.jpg' })).toEqual({ ok: true, href: 'https://raw.example/Image/Profile/Mitsuki.jpg' });
        expect(menuLinkOpenVerdict({ ...clicked, url: 'http://a.example/x' }).ok).toBe(true);
    });
    it('MUTATION TARGET — refuses a frame that is not a menu frame', () => {
        expect(menuLinkOpenVerdict({ ...clicked, isMenuFrame: false, url: 'https://a.example/' }).ok).toBe(false);
    });
    it('MUTATION TARGET — refuses without a click, and when the browser cannot say', () => {
        expect(menuLinkOpenVerdict({ ...clicked, userActivation: false, url: 'https://a.example/' }).ok).toBe(false);
        const unknown = menuLinkOpenVerdict({ ...clicked, userActivation: null, url: 'https://a.example/' });
        expect(unknown.ok).toBe(false);
        expect(unknown.reason).toMatch(/cannot say/);
    });
    it('MUTATION TARGET — refuses every scheme but http(s), and a relative URL', () => {
        for (const url of ['javascript:alert(1)', 'data:text/html,x', 'blob:https://a.example/1', 'file:///C:/x', '/user/images/a.png']) {
            expect(menuLinkOpenVerdict({ ...clicked, url }).ok).toBe(false);
        }
    });
});

describe('the srcdoc', () => {
    const prelude = menuFramePrelude({ mid: 7, mvuData: { stat_data: { a: 1 } } });
    const csp = buildMenuFrameCsp({});
    const body = '<!DOCTYPE html>\n<html><head><title>m</title></head><body><script>menu()</script></body></html>';
    const srcdoc = composeMenuFrameSrcdoc({ csp, prelude, body });

    it('MUTATION TARGET — DOCTYPE, then the CSP, then the prelude, then the author document', () => {
        const at = (s) => srcdoc.indexOf(s);
        expect(srcdoc.startsWith('<!DOCTYPE html>')).toBe(true);
        expect(at('http-equiv="Content-Security-Policy"')).toBeGreaterThan(0);
        expect(at('http-equiv="Content-Security-Policy"')).toBeLessThan(at('<script>'));
        expect(at('<script>')).toBeLessThan(at('<body>'));
        expect(at('<body>')).toBeLessThan(at(body));
    });
    it('carries the CSP with its quotes escaped for the attribute', () => {
        expect(srcdoc).toContain('content="default-src &#39;none&#39;;'.replace('&#39;', "'").replace('&#39;', "'"));
        expect(srcdoc).toContain("default-src 'none'; script-src 'unsafe-inline'");
    });
    it("keeps TavernHelper's base style, which every menu is written against", () => {
        expect(srcdoc).toContain('html,body{margin:0!important;padding:0;overflow:hidden!important;max-width:100%!important;}');
    });
    it('refuses a prelude that would end its own script element', () => {
        expect(() => composeMenuFrameSrcdoc({ csp, prelude: 'x</script>y', body })).toThrow(TypeError);
    });
});

describe('the prelude', () => {
    it('has no template hole left and no script terminator', () => {
        const prelude = menuFramePrelude({ mid: 3, mvuData: { stat_data: { x: 'y' } } });
        expect(prelude).not.toContain('__MID__');
        expect(prelude).not.toContain('__MVU__');
        expect(prelude).not.toContain('{{');
        expect(prelude).not.toMatch(/<\/script/i);
    });

    it('defines every name the builder runtime feature-detects first (containment §5)', () => {
        const { window } = runPrelude(menuFramePrelude({ mid: 3, mvuData: { stat_data: { hp: 5 } } }));
        for (const name of ['getCurrentMessageId', 'getVariables', 'waitGlobalInitialized', 'eventOn']) {
            expect(typeof window[name]).toBe('function');
        }
        expect(typeof window.Mvu.getMvuData).toBe('function');
        expect(window.Mvu.events.VARIABLE_UPDATE_ENDED).toBe('mag_variable_update_ended');
        expect(typeof window._.get).toBe('function');
        expect(typeof window._.set).toBe('function');
        expect(typeof window.MvuHelperFrame.lorebookContent).toBe('function');
        expect(window.MvuHelperFrame.version).toBe(1);
        expect(typeof window.localStorage.getItem).toBe('function');
    });

    it('answers the baked state synchronously, as the runtime reads it (getVariables is not awaited)', () => {
        const { window } = runPrelude(menuFramePrelude({ mid: 12, mvuData: { stat_data: { hp: 5 } } }));
        expect(window.getCurrentMessageId()).toBe(12);
        expect(window.getVariables({ type: 'message', message_id: 12 })).toEqual({ stat_data: { hp: 5 } });
        expect(window.getVariables()).toEqual({ stat_data: { hp: 5 } });
        expect(window.Mvu.getMvuData({ type: 'chat' })).toEqual({ stat_data: { hp: 5 } });
    });

    // The builder's runtime, quoted: rt_mvuConnection.js initMvuConnection (target selection and the
    // await), refreshFromMvu (the sync getVariables read), resolveCurrentMessageId (the API before
    // window.name), and rt_dataHelpers.js:14 as B1 leaves it (own window first). Against a parent
    // whose every read throws, this chain must RESOLVE — one missing name and it rejects at link one.
    it('MUTATION TARGET — the init chain survives a parent whose every read throws', async () => {
        const { window } = runPrelude(menuFramePrelude({ mid: 4, mvuData: { stat_data: { hp: 9 } } }));
        const chain = async () => {
            const _ = (typeof window._ !== 'undefined' && window._) ? window._ : (window.parent && window.parent._);
            let target = null;
            if (typeof window.waitGlobalInitialized === 'function') target = window;
            else if (window.parent && typeof window.parent.waitGlobalInitialized === 'function') target = window.parent;
            await target.waitGlobalInitialized('Mvu');
            const Mvu = target.Mvu;
            const chatData = Mvu.getMvuData({ type: 'chat' });
            const targetWindow = (typeof window.getVariables === 'function' && window) || (window.parent && typeof window.parent.getVariables === 'function' && window.parent) || null;
            const msgId = typeof window.getCurrentMessageId === 'function' ? Number(window.getCurrentMessageId()) : -1;
            const vars = targetWindow.getVariables({ type: 'message', message_id: msgId });
            return { hp: _.get(vars, 'stat_data.hp'), chat: chatData.stat_data.hp, msgId };
        };
        await expect(chain()).resolves.toEqual({ hp: 9, chat: 9, msgId: 4 });
    });

    // The menu's first state comes from the push READY asks for; a READY posted before the listener that
    // takes the push is in would ask for a state nothing is there to receive.
    it('MUTATION TARGET — says READY once, after its inbound message listener is in', () => {
        const steps = [];
        const win = {
            parent: { postMessage: (m) => steps.push('post:' + m.type) },
            addEventListener: (name) => steps.push('listen:' + name),
            requestAnimationFrame() {}, innerWidth: 0, innerHeight: 0,
        };
        new Function('window', 'document', menuFramePrelude({ mid: 2, mvuData: { stat_data: null } }))(win, { addEventListener() {}, body: null, baseURI: ST_ORIGIN + '/' });
        const ready = steps.indexOf('post:' + MENU_FRAME_READY_MESSAGE);
        expect(steps.filter((s) => s === 'post:' + MENU_FRAME_READY_MESSAGE)).toHaveLength(1);
        expect(steps.indexOf('listen:message')).toBeGreaterThan(-1);
        expect(steps.indexOf('listen:message')).toBeLessThan(ready);
    });

    it('a state push re-answers and fires the VARIABLE_UPDATE_ENDED subscription with the new snapshot', () => {
        const { window } = runPrelude(menuFramePrelude({ mid: 4, mvuData: { stat_data: { hp: 9 } } }));
        // capture the message listener the prelude installed
        const listeners = [];
        window.addEventListener = (name, fn) => { if (name === 'message') listeners.push(fn); };
        const { window: w2 } = (() => {
            const posted = [];
            const win = { parent: { postMessage: (m) => posted.push(m) }, addEventListener: (name, fn) => { if (name === 'message') listeners.push(fn); }, requestAnimationFrame() {}, innerWidth: 0, innerHeight: 0 };
            new Function('window', 'document', menuFramePrelude({ mid: 4, mvuData: { stat_data: { hp: 9 } } }))(win, { addEventListener() {}, body: null });
            return { window: win, posted };
        })();
        const seen = [];
        w2.eventOn(w2.Mvu.events.VARIABLE_UPDATE_ENDED, (vars) => seen.push(vars));
        for (const fn of listeners) fn({ data: { type: MENU_STATE_MESSAGE, mid: 5, statData: { hp: 1 } } });
        expect(w2.getCurrentMessageId()).toBe(5);
        expect(w2.getVariables()).toEqual({ stat_data: { hp: 1 } });
        expect(seen).toEqual([{ stat_data: { hp: 1 } }]);
        expect(window).toBeTruthy();
    });

    // Measured live: an error thrown in a <script type="module"> reaches the error event with the
    // message "Uncaught " and nothing else; only `error` says it was a SecurityError. The host's warn
    // keys on that word to name the re-export fix, so the prelude must report the thrown value.
    it('MUTATION TARGET — reports the THROWN value, not the bare "Uncaught " a module error arrives with', () => {
        const posted = [];
        const handlers = {};
        const win = {
            parent: { postMessage: (m) => posted.push(m) },
            addEventListener: (name, fn) => { handlers[name] = handlers[name] || []; handlers[name].push(fn); },
            requestAnimationFrame() {}, innerWidth: 0, innerHeight: 0,
        };
        new Function('window', 'document', menuFramePrelude({ mid: 1, mvuData: { stat_data: null } }))(win, { addEventListener() {}, body: null, baseURI: 'http://127.0.0.1:8000/' });
        handlers.error.forEach((fn) => fn({ message: 'Uncaught ', error: { name: 'SecurityError', message: "Failed to read a named property '_' from 'Window'" }, filename: 'about:srcdoc', lineno: 0 }));
        const report = posted.find((m) => m.type === MENU_FRAME_ERROR_MESSAGE);
        expect(report.message).toBe("SecurityError: Failed to read a named property '_' from 'Window'");
        // and a plain event with no thrown value still says what it can
        posted.length = 0;
        handlers.error.forEach((fn) => fn({ message: 'Script error.', error: null, filename: '', lineno: 0 }));
        expect(posted.find((m) => m.type === MENU_FRAME_ERROR_MESSAGE).message).toBe('Script error.');
    });

    // A click on a link, as the window's bubbling listener sees it. `href` is the attribute as written.
    function clickOn(href, over) {
        const posted = [];
        const handlers = {};
        const win = {
            parent: { postMessage: (m) => posted.push(m) },
            addEventListener: (name, fn) => { handlers[name] = handlers[name] || []; handlers[name].push(fn); },
            requestAnimationFrame() {}, innerWidth: 0, innerHeight: 0,
        };
        new Function('window', 'document', menuFramePrelude({ mid: 1, mvuData: { stat_data: null } }))(win, { addEventListener() {}, body: null, baseURI: ST_ORIGIN + '/' });
        const link = { getAttribute: (name) => (name === 'href' ? href : null) };
        const event = Object.assign({
            button: 0, defaultPrevented: false, prevented: false,
            target: { closest: (selector) => (selector.includes('a[href]') ? link : null) },
            preventDefault() { this.prevented = true; },
        }, over);
        handlers.click.forEach((fn) => fn(event));
        return { event, links: posted.filter((m) => m.type === MENU_LINK_MESSAGE) };
    }
    it('MUTATION TARGET — an http(s) link click goes to the page, and the menu stays where it is', () => {
        const { event, links } = clickOn('https://raw.example/Image/Profile/Mitsuki.jpg');
        expect(event.prevented).toBe(true);
        expect(links).toEqual([{ type: MENU_LINK_MESSAGE, url: 'https://raw.example/Image/Profile/Mitsuki.jpg' }]);
    });
    it('a relative link is resolved first, so the page is handed an absolute URL', () => {
        expect(clickOn('user/images/a.png').links[0].url).toBe(ST_ORIGIN + '/user/images/a.png');
    });
    it('an in-page anchor, a non-web scheme, a middle click and a link the menu handled stay the menu\'s', () => {
        for (const [href, over] of [['#stats'], ['javascript:void(0)'], ['mailto:a@b.example'], ['https://a.example/', { button: 1 }], ['https://a.example/', { defaultPrevented: true }]]) {
            const { event, links } = clickOn(href, over);
            expect(event.prevented).toBe(false);
            expect(links).toEqual([]);
        }
    });
    it('a click that is not on a link does nothing', () => {
        const { event, links } = clickOn('https://a.example/', { target: { closest: () => null } });
        expect(event.prevented).toBe(false);
        expect(links).toEqual([]);
    });

    it('lodash get/set cover the dotted and bracketed paths a layout binds', () => {
        const { window } = runPrelude(menuFramePrelude({ mid: 0, mvuData: { stat_data: null } }));
        const obj = { a: { b: [{ c: 3 }] } };
        expect(window._.get(obj, 'a.b[0].c')).toBe(3);
        expect(window._.get(obj, 'a.b.0.c')).toBe(3);
        expect(window._.get(obj, 'a.x.y', 'dflt')).toBe('dflt');
        window._.set(obj, 'a.d.0', 'z');
        expect(obj.a.d).toEqual(['z']);
    });

    it('the localStorage shadow behaves like Storage and lives in memory only (D3)', () => {
        const { window } = runPrelude(menuFramePrelude({ mid: 0, mvuData: { stat_data: null } }));
        window.localStorage.setItem('mzsb_img_x', 'data:1');
        expect(window.localStorage.getItem('mzsb_img_x')).toBe('data:1');
        expect(window.localStorage.length).toBe(1);
        window.localStorage.removeItem('mzsb_img_x');
        expect(window.localStorage.getItem('mzsb_img_x')).toBeNull();
    });

    it('embeds stat_data safely inside a script element', () => {
        const prelude = menuFramePrelude({ mid: 1, mvuData: { stat_data: { note: '</script><!--' } } });
        expect(prelude).not.toMatch(/<\/script/i);
        expect(prelude).not.toContain('<!--');
        const { window } = runPrelude(prelude);
        expect(window.getVariables().stat_data.note).toBe('</script><!--');
    });

    // MUTATION TARGET — make the replacement the separator itself (the escape a no-op): the raw
    // characters then reach the prelude source and this test fails.
    it('escapes U+2028 / U+2029 in stat_data, and they round-trip', () => {
        const text = 'a' + String.fromCharCode(0x2028) + 'b' + String.fromCharCode(0x2029) + 'c';
        const prelude = menuFramePrelude({ mid: 1, mvuData: { stat_data: { note: text } } });
        expect(prelude.includes(String.fromCharCode(0x2028))).toBe(false);
        expect(prelude.includes(String.fromCharCode(0x2029))).toBe(false);
        expect(runPrelude(prelude).window.getVariables().stat_data.note).toBe(text);
    });
});

describe('when the host pushes state', () => {
    // A frame carries no state, and when a chat opens its menu is ready before the card's MVU exists
    // (measured live 2026-09-23: frame appended at 36,286 ms, Mvu defined at 36,502 ms, every cell "???"
    // until the next turn). These pin the two pushes that fill it — the one READY asks for and the one
    // on MVU's arrival; the host file cannot be opened by a test, so the guard reads it.
    const host = readFileSync(new URL('../src/features/statusmenu-pack/statusmenu-frame.js', import.meta.url), 'utf8').replace(/\r/g, '');
    const bodyOf = (signature) => { const from = host.slice(host.indexOf(signature)); return from.slice(0, from.indexOf('\n}')); };

    it('the MVU-ready event is the one TavernHelper emits for initializeGlobal("Mvu")', () => {
        const global = 'Mvu';
        expect(MENU_MVU_READY_EVENT).toBe(`global_${global}_initialized`);
    });
    it('the host pushes state to every frame when that event fires', () => {
        expect(host).toMatch(/eventSource\.on\(MENU_MVU_READY_EVENT,\s*\(\)\s*=>\s*\{\s*pushMenuState\(/);
    });
    // A frame's `load` waits for every image the menu shows; READY comes once the prelude has run.
    it('MUTATION TARGET — the host answers every READY with a push, ungated', () => {
        expect(bodyOf('function onFrameMessage(')).toMatch(/if \(msg\.kind === 'ready'\) \{\s*onMenuReady\(entry\);/);
        expect(bodyOf('function onMenuReady(')).toMatch(/\n {4}pushTo\(entry,/);   // at the function's own depth: no gate around it
    });
    it("a load — the frame element's own, or the wrapper's report of a menu reload — drops a lift and pushes nothing", () => {
        const listener = host.slice(host.indexOf("frame.addEventListener('load'"));
        const listenerBody = listener.slice(0, listener.indexOf('\n    });'));
        expect(listenerBody).toMatch(/\n {8}onMenuLoad\(entry,/);   // at the listener's own depth: no gate around it
        expect(host).toMatch(/if \(msg\.kind === 'reloaded'\) \{\s*onMenuLoad\(entry,/);
        const onLoad = bodyOf('function onMenuLoad(');
        expect(onLoad).toMatch(/\n {4}applyLiftStep\(entry, 'load'\);/);
        expect(onLoad).not.toContain('pushTo(');
    });
});

// An edit outside a reply (TavernHelper's variable editor, Mvu.replaceMvuData, setMvuVariable, a script)
// emits nothing; every one of them stores a NEW object in the message's variables slot, so the host
// compares that object with the one it last pushed and skips when it is the same.
describe('an edit no event announces — which frames to push', () => {
    const slotA = { stat_data: { hp: 1 } };
    const slotB = { stat_data: { hp: 2 } };
    const chatWith = (slot) => [{ swipe_id: 0, variables: [slot] }];

    it('reads the current swipe\'s slot, in the array form and the older keyed form', () => {
        expect(menuStateSlot({ swipe_id: 1, variables: [slotA, slotB] })).toBe(slotB);
        expect(menuStateSlot({ variables: [slotA] })).toBe(slotA);
        expect(menuStateSlot({ swipe_id: 0, variables: { 0: slotA } })).toBe(slotA);
        expect(menuStateSlot({ swipe_id: 0 })).toBe(null);
        expect(menuStateSlot(null)).toBe(null);
    });
    // MUTATION TARGET: make menuStatesToPush return every entry and this fails — an idle chat would
    // redraw every menu every MENU_STATE_CHECK_MS.
    it('an unchanged slot is skipped — no push, no redraw', () => {
        expect(menuStatesToPush([{ mid: 0, pushedSlot: slotA }], chatWith(slotA))).toEqual([]);
    });
    // MUTATION TARGET: make menuStatesToPush return nothing and this fails — the edit never reaches the menu.
    it('a replaced slot is pushed', () => {
        const entry = { mid: 0, pushedSlot: slotA };
        expect(menuStatesToPush([entry], chatWith(slotB))).toEqual([entry]);
    });
    it('the same data in a NEW object still counts — an edit is a replacement, whatever it wrote', () => {
        const entry = { mid: 0, pushedSlot: slotA };
        expect(menuStatesToPush([entry], chatWith({ stat_data: { hp: 1 } }))).toEqual([entry]);
    });
    it('a swipe to another take is pushed', () => {
        const entry = { mid: 0, pushedSlot: slotA };
        expect(menuStatesToPush([entry], [{ swipe_id: 1, variables: [slotA, slotB] }])).toEqual([entry]);
    });
    it('a message that left the chat, or one with no variables pushed or present, is skipped', () => {
        expect(menuStatesToPush([{ mid: 5, pushedSlot: slotA }], chatWith(slotA))).toEqual([]);
        expect(menuStatesToPush([{ mid: 0, pushedSlot: null }], [{ swipe_id: 0 }])).toEqual([]);
        expect(menuStatesToPush([{ mid: 0, pushedSlot: slotA }], null)).toEqual([]);
    });
    it('checks every 2 seconds', () => {
        expect(MENU_STATE_CHECK_MS).toBe(2000);
    });

    const host = readFileSync(new URL('../src/features/statusmenu-pack/statusmenu-frame.js', import.meta.url), 'utf8');
    // MUTATION TARGET: move the record below the read and an edit landing during the read passes as shown.
    it('every push records the slot BEFORE it reads the state', () => {
        const body = host.slice(host.indexOf('async function pushTo('));
        const record = body.indexOf('entry.pushedSlot = currentStateSlot(entry.mid);');
        const read = body.indexOf('await mvuDataFor(entry.mid)');
        expect(record).toBeGreaterThan(-1);
        expect(read).toBeGreaterThan(record);
    });
    it('the check starts with the first mounted frame and stops with the last, and on a chat change', () => {
        expect(host).toMatch(/frames\.set\(frame, entry\);\s*startStateCheck\(\);/);
        expect(host).toMatch(/if \(!frames\.size\) \{ stopStateCheck\(\); return; \}/);
        expect(host).toMatch(/frames\.clear\(\);\s*stopStateCheck\(\);/);
    });
});

// The turn's write re-renders its reply and takes the menu inside with it; measured on ArtificKoi
// (2026-10-27), POST's state push reached that menu ~90 ms before the write removed it, so the menu redrew
// and asked for its formatters with nobody left to answer.
describe('a push the turn\'s write would undo', () => {
    it('MUTATION TARGET — an update to a menu whose reply the write is about to re-render waits', () => {
        expect(shouldMenuPushWait({ isMenuStarting: false, isWriteDue: true })).toBe(true);
    });
    it('MUTATION TARGET — a menu that has just started gets its first state at once, write or not', () => {
        expect(shouldMenuPushWait({ isMenuStarting: true, isWriteDue: true })).toBe(false);
    });
    it('MUTATION TARGET — with no write due, every push goes now', () => {
        expect(shouldMenuPushWait({ isMenuStarting: false, isWriteDue: false })).toBe(false);
        expect(shouldMenuPushWait({ isMenuStarting: true, isWriteDue: false })).toBe(false);
    });

    const host = readFileSync(new URL('../src/features/statusmenu-pack/statusmenu-frame.js', import.meta.url), 'utf8').replace(/\r/g, '');
    const bodyOf = (signature) => { const from = host.slice(host.indexOf(signature)); return from.slice(0, from.indexOf('\n}')); };
    it('MUTATION TARGET — every push asks first, before it records or reads anything, and a held one returns', () => {
        const body = bodyOf('async function pushTo(');
        const ask = body.indexOf('if (shouldMenuPushWait({ isMenuStarting, isWriteDue: isReplyWriteDue(entry.mid) })) {\n        holdPushForWrite(entry, reason);\n        return;\n    }');
        expect(ask).toBeGreaterThan(-1);
        expect(body.indexOf('entry.pushedSlot = currentStateSlot(entry.mid);')).toBeGreaterThan(ask);
    });
    it('MUTATION TARGET — READY\'s push is the menu starting', () => {
        expect(bodyOf('function onMenuReady(')).toContain("pushTo(entry, 'menu ready', { isMenuStarting: true })");
    });
    it('MUTATION TARGET — a held push waits for the write to end, then is dropped for a menu gone from the page', () => {
        const body = bodyOf('function holdPushForWrite(');
        expect(body).toContain('if (entry.heldPushReason) return;');
        expect(body).toContain('dueReplyWriteEnded(entry.mid).then(');
        expect(body).toMatch(/if \(!entry\.frame\.isConnected\) \{[^}]*return;\s*\}\s*return pushTo\(entry,/);
    });
});

describe('the wire — readers', () => {
    it('height, overlay and error are read; malformed shapes are refused by name; foreign traffic is not ours', () => {
        expect(readMenuFrameMessage({ type: MENU_FRAME_HEIGHT_MESSAGE, height: 412.4 })).toEqual({ mine: true, ok: true, kind: 'height', height: 412 });
        expect(readMenuFrameMessage({ type: MENU_FRAME_HEIGHT_MESSAGE, height: -1 }).ok).toBe(false);
        expect(readMenuFrameMessage({ type: MENU_FRAME_OVERLAY_MESSAGE, open: true })).toEqual({ mine: true, ok: true, kind: 'overlay', open: true });
        expect(readMenuFrameMessage({ type: MENU_FRAME_OVERLAY_MESSAGE, open: 'yes' }).ok).toBe(false);
        expect(readMenuFrameMessage({ type: MENU_FRAME_ERROR_MESSAGE, message: 'boom', source: 'about:srcdoc', line: 3 })).toEqual({ mine: true, ok: true, kind: 'error', message: 'boom', source: 'about:srcdoc', line: 3 });
        expect(readMenuFrameMessage({ type: MENU_FRAME_READY_MESSAGE })).toEqual({ mine: true, ok: true, kind: 'ready' });
        expect(readMenuFrameMessage({ type: 'mvu-statusmenu-action' }).mine).toBe(false);
        expect(readMenuFrameMessage(null).mine).toBe(false);
    });
    it("the wrapper's two: a refused load carries its address, a reload carries nothing", () => {
        expect(readMenuFrameMessage({ type: MENU_FRAME_BLOCKED_MESSAGE, url: 'https://example.com' })).toEqual({ mine: true, ok: true, kind: 'blocked', url: 'https://example.com' });
        expect(readMenuFrameMessage({ type: MENU_FRAME_BLOCKED_MESSAGE }).ok).toBe(false);
        expect(readMenuFrameMessage({ type: MENU_FRAME_RELOADED_MESSAGE })).toEqual({ mine: true, ok: true, kind: 'reloaded' });
    });
    it('a lorebook request needs a requestId and a key', () => {
        expect(readMenuLorebookContentRequest({ type: MENU_LOREBOOK_CONTENT_MESSAGE, requestId: 'r1', key: ' Portrait ' })).toEqual({ mine: true, ok: true, requestId: 'r1', key: 'Portrait' });
        expect(readMenuLorebookContentRequest({ type: MENU_LOREBOOK_CONTENT_MESSAGE, requestId: 'r1' }).ok).toBe(false);
        expect(readMenuLorebookContentRequest({ type: MENU_LOREBOOK_CONTENT_MESSAGE, key: 'k' }).ok).toBe(false);
        expect(readMenuLorebookContentRequest({ type: 'other' }).mine).toBe(false);
    });
});

describe('menuFrameErrorVerdict — which fix a frame error names', () => {
    it('a SecurityError is the cross-origin case — the re-export fix', () => {
        expect(menuFrameErrorVerdict({ message: "SecurityError: Failed to read a named property '_' from 'Window'", source: 'about:srcdoc' })).toBe('cross-origin');
        expect(menuFrameErrorVerdict({ message: 'Blocked a frame with origin "null" from accessing a cross-origin frame.' })).toBe('cross-origin');
    });
    it('the image rescue reports as image; anything else is the menu\'s own fault', () => {
        expect(menuFrameErrorVerdict({ message: 'SillyTavern image not shown: x', source: 'image' })).toBe('image');
        expect(menuFrameErrorVerdict({ message: 'TypeError: x is not a function', source: 'about:srcdoc' })).toBe('menu');
        expect(menuFrameErrorVerdict({})).toBe('menu');
    });
});

describe('lorebookContentByKey — the mediated read (D5)', () => {
    const entries = [
        { uid: 1, comment: 'Portrait Umi', keys: ['umi_portrait', 'Umi'], content: '  https://img.example/umi.png  ' },
        { uid: 2, comment: '[Initmvuhelper] mvu-helper card config', keys: [], content: '{ "secret": true }' },
        { uid: 3, comment: 'Empty', keys: ['empty'], content: '   ' },
    ];
    it('matches keys[] or comment, trimmed and case-insensitive, exactly as the menu did client-side', () => {
        expect(lorebookContentByKey(entries, 'UMI')).toBe('https://img.example/umi.png');
        expect(lorebookContentByKey(entries, ' portrait umi ')).toBe('https://img.example/umi.png');
        expect(lorebookContentByKey(entries, 'nope')).toBeNull();
        expect(lorebookContentByKey(entries, 'empty')).toBeNull();
        expect(lorebookContentByKey(entries, '')).toBeNull();
        expect(lorebookContentByKey(null, 'umi')).toBeNull();
    });
    it('MUTATION TARGET — answers with the content STRING only, never the entry', () => {
        const answer = lorebookContentByKey(entries, 'umi');
        expect(typeof answer).toBe('string');
        expect(answer).not.toContain('uid');
        expect(answer).not.toContain('Portrait Umi');
    });
});

describe('the frame element (D2)', () => {
    it('lifts to the viewport while an overlay is open, and rests in flow otherwise', () => {
        expect(MENU_FRAME_LIFTED_STYLE).toContain('position:fixed');
        expect(MENU_FRAME_LIFTED_STYLE).toContain('inset:0');
        expect(MENU_FRAME_STYLE).not.toContain('position:fixed');
        expect(MENU_FRAME_STYLE).toContain('width:100%');
    });
    // The lifted frame is shown as a popover, and these are the popover defaults that would otherwise
    // pad it, paint it Canvas-white behind the menu's own dimmer, and shrink it to fit-content.
    it('the lifted style overrides every popover default it would otherwise inherit', () => {
        for (const rule of ['padding:0', 'background:transparent', 'border:0', 'margin:0', 'width:100vw']) {
            expect(MENU_FRAME_LIFTED_STYLE).toContain(rule);
        }
    });
    it('the height is the VISIBLE one: 100dvh declared after 100vh, so the later wins where supported', () => {
        expect(MENU_FRAME_LIFTED_STYLE.indexOf('height:100dvh')).toBeGreaterThan(MENU_FRAME_LIFTED_STYLE.indexOf('height:100vh'));
    });
});

describe('menuFrameLiftStep — when the host lifts and drops a frame', () => {
    it('an overlay opening lifts a resting frame, and does nothing to a lifted one', () => {
        expect(menuFrameLiftStep(false, 'overlay-open')).toBe('lift');
        expect(menuFrameLiftStep(true, 'overlay-open')).toBe(null);
    });
    it('an overlay closing drops a lifted frame, and does nothing to a resting one', () => {
        expect(menuFrameLiftStep(true, 'overlay-closed')).toBe('drop');
        expect(menuFrameLiftStep(false, 'overlay-closed')).toBe(null);
    });
    // A reloaded document never reports its overlay closed, so without this the empty frame would stay
    // over the whole page, in the top layer, above SillyTavern's own bars.
    it('MUTATION TARGET — a lifted frame that LOADS again is dropped', () => {
        expect(menuFrameLiftStep(true, 'load')).toBe('drop');
        expect(menuFrameLiftStep(false, 'load')).toBe(null);
    });
    it('an unknown event does nothing', () => {
        expect(menuFrameLiftStep(true, 'resize')).toBe(null);
        expect(menuFrameLiftStep(false, undefined)).toBe(null);
    });
});

describe('the wrapper — the menu frame keeps its own document', () => {
    const menuSrcdoc = composeMenuFrameSrcdoc({
        csp: buildMenuFrameCsp({}),
        prelude: menuFramePrelude({ mid: 2, mvuData: { stat_data: { quote: '"<&>' } } }),
        body: '<p class="x">menu & "quotes" <b>bold</b></p>',
    });
    const wrapper = composeMenuFrameWrapperSrcdoc({ menuSrcdoc, title: 'Status "Menu" <1>' });
    const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const frameTags = () => wrapper.match(/<iframe\b[^>]*>/g) || [];

    it("MUTATION TARGET — its policy is frame-src 'none' and nothing else: a srcdoc inherits it, so more would bind the menu", () => {
        expect(MENU_WRAPPER_CSP).toBe("frame-src 'none'");
        expect(wrapper.match(/http-equiv="Content-Security-Policy" content="[^"]*"/g)).toEqual([`http-equiv="Content-Security-Policy" content="frame-src 'none'"`]);
    });
    it('holds ONE menu frame with the menu sandbox, and the menu document round-trips through the attribute', () => {
        expect(frameTags()).toHaveLength(1);
        expect(frameTags()[0]).toContain('sandbox="' + MENU_FRAME_SANDBOX + '"');
        expect(unescape((frameTags()[0].match(/srcdoc="([^"]*)"/) || [])[1])).toBe(menuSrcdoc);
        expect(frameTags()[0]).toContain('title="Status &quot;Menu&quot; &lt;1&gt;"');
    });
    it('the policy and the relay come before the menu frame', () => {
        const at = (s) => wrapper.indexOf(s);
        expect(wrapper.startsWith('<!DOCTYPE html>')).toBe(true);
        expect(at('http-equiv="Content-Security-Policy"')).toBeLessThan(at('<script>'));
        expect(at('<script>')).toBeLessThan(at('<iframe'));
    });
    it('the menu frame fills the wrapper, which draws nothing of its own', () => {
        expect(wrapper).toContain('html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;}');
        expect(wrapper).toContain('iframe{display:block;border:0;width:100%;height:100%;}');
    });
    it('refuses a missing menu document, and its relay cannot end its own script element', () => {
        expect(() => composeMenuFrameWrapperSrcdoc({})).toThrow(TypeError);
        expect(() => composeMenuFrameWrapperSrcdoc({ menuSrcdoc: '' })).toThrow(TypeError);
        expect(wrapper.match(/<script>([\s\S]*?)<\/script>/)[1]).not.toMatch(/<\/script/i);
    });
});

// Run the wrapper's relay the way the wrapper does: a classic script against a window and a document.
// The host and the menu frame are stand-ins that record what they are posted.
function runRelay({ withMenu = true } = {}) {
    const wrapper = composeMenuFrameWrapperSrcdoc({ menuSrcdoc: '<!DOCTYPE html><p>menu</p>' });
    const script = wrapper.match(/<script>([\s\S]*?)<\/script>/)[1];
    const windowListeners = [];
    const documentListeners = [];
    const toHost = [];
    const toMenu = [];
    const host = { postMessage: (data, origin, ports) => toHost.push({ data, origin, ports }) };
    const menuWindow = { postMessage: (data, origin, ports) => toMenu.push({ data, origin, ports }) };
    const menuFrame = { tagName: 'IFRAME', contentWindow: menuWindow };
    const window = { parent: host, addEventListener: (type, fn) => { if (type === 'message') windowListeners.push(fn); } };
    const document = {
        querySelector: (selector) => (selector === 'iframe' && withMenu ? menuFrame : null),
        addEventListener: (type, fn, capture) => documentListeners.push({ type, fn, capture }),
    };
    new Function('window', 'document', script)(window, document);
    const post = (source, data, ports = []) => windowListeners.forEach((fn) => fn({ source, data, ports }));
    const fire = (type, event) => documentListeners.filter((l) => l.type === type).forEach((l) => l.fn(event));
    return { host, menuWindow, menuFrame, toHost, toMenu, post, fire, documentListeners };
}

describe("the wrapper's relay", () => {
    it('what the menu posts to its parent goes on to the host, unchanged, ports included', () => {
        const relay = runRelay();
        const port = { name: 'port' };
        relay.post(relay.menuWindow, { type: MENU_FRAME_HEIGHT_MESSAGE, height: 120 }, [port]);
        expect(relay.toHost).toEqual([{ data: { type: MENU_FRAME_HEIGHT_MESSAGE, height: 120 }, origin: '*', ports: [port] }]);
        expect(relay.toMenu).toEqual([]);
    });
    it('what anything else posts to the wrapper goes into the menu — the host, and any other window', () => {
        const relay = runRelay();
        relay.post(relay.host, { type: MENU_STATE_MESSAGE, mid: 3, statData: { a: 1 } });
        relay.post({ name: 'another window' }, 'plain text');
        expect(relay.toMenu.map((m) => m.data)).toEqual([{ type: MENU_STATE_MESSAGE, mid: 3, statData: { a: 1 } }, 'plain text']);
        expect(relay.toHost).toEqual([]);
    });
    it('MUTATION TARGET — the menu cannot speak as the wrapper: neither of its two types passes from the menu', () => {
        const relay = runRelay();
        relay.post(relay.menuWindow, { type: MENU_FRAME_BLOCKED_MESSAGE, url: 'https://example.com' });
        relay.post(relay.menuWindow, { type: MENU_FRAME_RELOADED_MESSAGE });
        expect(relay.toHost).toEqual([]);
    });
    it('MUTATION TARGET — a frame-src refusal is reported with its address; any other directive is not', () => {
        const relay = runRelay();
        relay.fire('securitypolicyviolation', { effectiveDirective: 'img-src', blockedURI: 'https://img.example' });
        relay.fire('securitypolicyviolation', { effectiveDirective: 'frame-src', blockedURI: 'https://example.com' });
        expect(relay.toHost.map((m) => m.data)).toEqual([{ type: MENU_FRAME_BLOCKED_MESSAGE, url: 'https://example.com' }]);
    });
    it('a reload of the menu frame is reported; its first load and other elements are not', () => {
        const relay = runRelay();
        expect(relay.documentListeners.find((l) => l.type === 'load').capture).toBe(true);   // a frame's load does not bubble
        relay.fire('load', { target: relay.menuFrame });
        relay.fire('load', { target: { tagName: 'IMG' } });
        expect(relay.toHost).toEqual([]);
        relay.fire('load', { target: relay.menuFrame });
        expect(relay.toHost.map((m) => m.data)).toEqual([{ type: MENU_FRAME_RELOADED_MESSAGE }]);
    });
    it('MUTATION TARGET — the load after a refusal is the error page, not the menu: not reported as a reload', () => {
        const relay = runRelay();
        relay.fire('load', { target: relay.menuFrame });
        relay.fire('securitypolicyviolation', { effectiveDirective: 'frame-src', blockedURI: 'https://example.com' });
        relay.fire('load', { target: relay.menuFrame });
        expect(relay.toHost.map((m) => m.data.type)).toEqual([MENU_FRAME_BLOCKED_MESSAGE]);
    });
    it('relays nothing before the menu frame exists', () => {
        const relay = runRelay({ withMenu: false });
        relay.post(relay.host, { type: MENU_STATE_MESSAGE });
        expect(relay.toMenu).toEqual([]);
        expect(relay.toHost).toEqual([]);
    });
});

describe("menuWindowOf — the menu's window inside a mounted frame", () => {
    it("MUTATION TARGET — is the wrapper's first frame, never the wrapper itself", () => {
        const menu = { name: 'menu' };
        const wrapperWindow = { frames: [menu] };
        expect(menuWindowOf(wrapperWindow)).toBe(menu);
        expect(menuWindowOf(wrapperWindow)).not.toBe(wrapperWindow);
    });
    it('is null before the wrapper has made the menu frame, and for no window', () => {
        expect(menuWindowOf({ frames: [] })).toBe(null);
        expect(menuWindowOf({})).toBe(null);
        expect(menuWindowOf(null)).toBe(null);
    });
    // Safari's cross-origin window throws "Sandbox access violation" for an index past `frames.length`
    // (a lazy menu frame still offscreen has made no menu frame yet); `length` itself is readable.
    // Chrome answers undefined. One such frame on the page made every lookup throw, so no menu loaded.
    const safariWindow = (children) => ({
        frames: new Proxy(children, {
            get(target, key) {
                if (typeof key === 'string' && /^\d+$/.test(key) && Number(key) >= target.length) {
                    throw new Error('Sandbox access violation: Blocked a frame from accessing a cross-origin frame.');
                }
                return Reflect.get(target, key);
            },
        }),
    });
    it("MUTATION TARGET — reads no index a Safari window has not got, so an empty wrapper is null, not a throw", () => {
        expect(menuWindowOf(safariWindow([]))).toBe(null);
        const menu = { name: 'menu' };
        expect(menuWindowOf(safariWindow([menu]))).toBe(menu);
    });
});

describe('menuFrameWindowRole — which windows speak for a mounted menu frame', () => {
    const menu = { name: 'menu' };
    const wrapperWindow = { frames: [menu] };
    it("the frame element's own window — the wrapper — is 'frame'", () => {
        expect(menuFrameWindowRole(wrapperWindow, wrapperWindow)).toBe('frame');
    });
    it("MUTATION TARGET — the menu inside the wrapper is 'menu': its window.top requests reach the page from there", () => {
        expect(menuFrameWindowRole(menu, wrapperWindow)).toBe('menu');
    });
    it('a frame the menu opens inside itself, any other window, and a missing window are neither', () => {
        const child = { name: 'child of the menu' };
        menu.frames = [child];
        expect(menuFrameWindowRole(child, wrapperWindow)).toBe(null);
        expect(menuFrameWindowRole({ name: 'other' }, wrapperWindow)).toBe(null);
        expect(menuFrameWindowRole(null, wrapperWindow)).toBe(null);
        expect(menuFrameWindowRole(menu, null)).toBe(null);
        expect(menuFrameWindowRole(menu, { frames: [] })).toBe(null);
    });
    it("MUTATION TARGET — a Safari wrapper with no menu frame yet answers null, so the host's lookup goes on to the next frame", () => {
        const emptySafariWrapper = { frames: new Proxy([], { get(target, key) { if (key === '0') throw new Error('Sandbox access violation'); return Reflect.get(target, key); } }) };
        expect(menuFrameWindowRole(menu, emptySafariWrapper)).toBe(null);
    });
});

describe('the host mounts the wrapper and knows the menu by both windows', () => {
    // The host file cannot be opened by a test (SillyTavern imports), so the guard reads it.
    const host = readFileSync(new URL('../src/features/statusmenu-pack/statusmenu-frame.js', import.meta.url), 'utf8').replace(/\r/g, '');
    const bodyOf = (signature) => { const from = host.slice(host.indexOf(signature)); return from.slice(0, from.indexOf('\n}')); };

    it('statusMenuFrameSource publishes the wrapper around the menu document, for every host', () => {
        expect(bodyOf('export async function statusMenuFrameSource(')).toMatch(/srcdoc: composeMenuFrameWrapperSrcdoc\(\{ menuSrcdoc,/);
    });
    it('MUTATION TARGET — both window lookups ask menuFrameWindowRole', () => {
        expect(bodyOf('function entryForSource(')).toContain('menuFrameWindowRole(source, entry.frame.contentWindow)');
        expect(bodyOf('function containedMenuFrameOf(')).toContain('menuFrameWindowRole(source, element.contentWindow)');
        expect(bodyOf('export function isContainedMenuFrame(')).toContain('containedMenuFrameOf(source)');
    });
    it("MUTATION TARGET — the wrapper's own two messages count only from the wrapper's window", () => {
        const handler = bodyOf('function onFrameMessage(');
        const guard = handler.indexOf("menuFrameWindowRole(event.source, entry.frame.contentWindow) !== 'frame'");
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(handler.indexOf("if (msg.kind === 'blocked')"));
        expect(guard).toBeLessThan(handler.indexOf("if (msg.kind === 'reloaded')"));
    });
    it('a refused load is warned, naming the menu and the address', () => {
        expect(bodyOf('function onFrameMessage(')).toMatch(/if \(msg\.kind === 'blocked'\) \{\s*log\.child\('frame'\)\.warn\('"' \+ entry\.rowName/);
    });
    // Through the relay a push is decoded and encoded once more inside the wrapper, and it carries the
    // whole stat_data (measured: a 1 MB push 155-186 ms through the relay, 80-111 ms straight to the menu).
    it("MUTATION TARGET — every state push goes to the menu's window, never through the wrapper's relay", () => {
        const push = bodyOf('async function pushTo(');
        expect(push).toContain('const win = menuWindowOf(entry.frame.contentWindow);');
        expect(push).not.toMatch(/=\s*entry\.frame\.contentWindow;/);
        expect(push).toMatch(/win\.postMessage\(\{ type: MENU_STATE_MESSAGE,/);
    });
    // A baked copy put the message's whole stat_data into every frame's srcdoc, escaped once more by the
    // wrapper — about 1.4 MB per reply on screen, offscreen ones included (School, measured in Safari).
    it('MUTATION TARGET — a mount puts no stat_data in the srcdoc and reads none', () => {
        const mount = bodyOf('async function mountInto(');
        expect(mount).toContain('await statusMenuFrameSource({ rowName, mid });');
        expect(mount).not.toContain('mvuDataFor(');
        expect(mount).not.toContain('statData');
    });
    // Every push trigger walks every mounted frame; a lazy frame offscreen has no menu window yet.
    it('MUTATION TARGET — a push reads stat_data only for a frame whose menu window exists', () => {
        const push = bodyOf('async function pushTo(');
        const presence = push.indexOf('if (!menuWindowOf(entry.frame.contentWindow)) return;');
        expect(presence).toBeGreaterThan(-1);
        expect(presence).toBeLessThan(push.indexOf('await mvuDataFor(entry.mid)'));
    });
});
