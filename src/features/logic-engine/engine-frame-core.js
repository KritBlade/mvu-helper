// logic-engine/engine-frame-core.js — the PURE half of the engine frame: the Content-Security-Policy
// the engine Worker runs under, and the frame document that carries it. No host imports; every decision
// here is unit-tested. engine-worker-host.js mounts what this decides.
//
// WHY A FRAME. Dynamic `import()` is syntax, not a global, so the capability block has no name to
// swap: with the block fully up, engine text could still `import()` any URL, and the request went out
// (measured 2026-08-06). Only a CSP refuses it, and a Worker started from a `blob:` URL takes its CSP
// from the document that made it — SillyTavern's page, which sends none. So the Worker is made by a
// hidden frame of ours whose document carries a `<meta>` CSP, the way the contained StatusMenu frame
// carries its own (statusmenu-frame-core.js).
//
// WHAT THE POLICY ALLOWS, and why each part is there:
//   • `script-src 'unsafe-eval'` and NOTHING ELSE — every engine text (the game's, each plugin's,
//     EventPack's) becomes code through `new Function` (logic-engine-core.js executeEngineText), which
//     needs it. No URL, host or scheme is listed, so dynamic `import()` — a script load — is refused for
//     EVERY URL, this extension's own files included, before any request is made.
//   • `worker-src blob: <exact file URLs>` — the frame starts the Worker from the blob holding its
//     bootstrap, and a module Worker's STATIC imports are Worker loads, governed by `worker-src`, not
//     `script-src` (measured live, Chrome 154, 2026-10-02: with the files listed under `script-src`
//     only, every one was refused under `worker-src`). Each is listed by its FULL PATH, never a folder
//     or host. The engine cannot reach `Worker` (the capability block takes it), so nothing but our
//     bootstrap ever loads through this directive.
//   • `default-src 'none'` — everything else, `connect-src` included (fetch, XHR, WebSocket,
//     EventSource, sendBeacon), refused.

// Every module the engine Worker loads, as paths inside the extension folder: the bootstrap's two
// imports and everything they import in turn. tests/engine-frame-core.test.js derives the import graph
// from the files themselves and fails until this list matches it — a module missing here is refused
// under `worker-src` and the Worker never starts.
export const ENGINE_WORKER_MODULES = Object.freeze([
    'src/features/logic-engine/engine-capability-block.js',
    'src/features/logic-engine/logic-engine-core.js',
    'src/sillytavern/extension-paths.js',
    'src/shared/engine-header.js',
    'src/shared/public-settings-core.js',
    'src/shared/object-path.js',
]);

// Stamped on the frame element, so it can be found on the page and told from every other iframe.
export const ENGINE_FRAME_ATTRIBUTE = 'data-mvu-helper-engine-frame';

/**
 * A module URL as a CSP source expression: the full URL with `;` and `,` percent-encoded (the policy's
 * own separators; CSP compares paths percent-decoded, so the match is unchanged).
 * @param {string} href an absolute http(s) URL with no query, fragment or credentials
 * @returns {string}
 * @throws {Error} naming the URL, for anything a source expression cannot carry exactly
 */
export function cspSourceForUrl(href) {
    let url;
    try { url = new URL(String(href)); }
    catch (e) { throw new Error(`engine frame: "${href}" is not an absolute URL (${e.message})`); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`engine frame: "${href}" is not an http(s) URL`);
    if (url.username || url.password) throw new Error(`engine frame: "${href}" carries credentials`);
    if (url.search || url.hash) throw new Error(`engine frame: "${href}" carries a query or fragment, which a source expression cannot match`);
    if (/\s/.test(url.href)) throw new Error(`engine frame: "${href}" contains whitespace`);
    return url.href.replace(/;/g, '%3B').replace(/,/g, '%2C');
}

/**
 * The engine frame's policy, inherited by the Worker it starts.
 * @param {string[]} moduleUrls the absolute URLs of ENGINE_WORKER_MODULES
 * @returns {string}
 */
export function buildEngineFrameCsp(moduleUrls) {
    const sources = (moduleUrls || []).map(cspSourceForUrl);
    if (!sources.length) throw new Error('engine frame: no module URLs — the Worker could load nothing');
    return [
        "default-src 'none'",
        "script-src 'unsafe-eval'",
        ['worker-src blob:', ...sources].join(' '),
    ].join('; ');
}

const escapeAttribute = (text) => String(text)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The frame's whole document: the policy and nothing else. The frame runs no script of its own; it
 * exists to own the Worker.
 * @param {string} csp from buildEngineFrameCsp
 * @returns {string}
 */
export function composeEngineFrameSrcdoc(csp) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8">'
        + `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`
        + '</head><body></body></html>';
}
