// logic-engine/engine-worker-host.js — run the card's UNTRUSTED engine in a Worker.
//
// WHY A WORKER, and why the in-realm capability block was not enough (LOGIC_ENGINE_PLAN §11.5
// residual 3, measured live in Chrome 2026-08-06):
//   • `document` is a NON-CONFIGURABLE own accessor of `window` (WebIDL [LegacyUnforgeable]), so
//     `defineProperty` cannot replace it. The block never took it away — and
//     `document.createElement('iframe')` + append yields a FRESH REALM whose `fetch` and
//     `localStorage` were never ours to swap (verified: contentWindow.Object !== window.Object).
//   • Child frames are INDEXED own properties (`window[0]` … `window[N-1]`) and Blink refuses to
//     redefine an indexed property at all. SillyTavern had 12 live frames; `window[0].fetch` is a
//     working function reached without touching the DOM.
// Both are the `location`/`top` class: the browser will not let us swap them. No longer list can
// close a hole that is not a name.
//
// A Worker has NO `document`, NO frames, NO `window.parent`, and no way to mint a realm — so the
// escape has nowhere to land. That is the whole point of moving.
//
// ⚠ A WORKER IS NOT A SANDBOX BY ITSELF. It still has `fetch`, `XMLHttpRequest`, `WebSocket`,
// `importScripts`, `indexedDB`, `caches` — every exfil sink the block exists to remove. So the SAME
// default-deny block runs INSIDE the Worker, importing the same module by absolute URL so there is
// one allow-list, not two that drift. The Worker is what makes the block airtight; the block is what
// makes the Worker safe. Neither alone is sufficient.
//
// WHERE THE WORKER IS BORN: inside the ENGINE FRAME, never on SillyTavern's page. The block swaps
// NAMES, and dynamic `import()` is syntax — with the block fully up it still loaded any URL. Only a
// Content-Security-Policy refuses it, and a Worker started from a blob takes its policy from the
// document that made it. SillyTavern's page sends none, so the Worker is made by a hidden frame whose
// document carries one (engine-frame-core.js has the policy and why each part is there). The frame
// makes the blob URL AND owns the Worker, so the policy reaches the Worker whichever of the two a
// browser inherits it from. The frame is created once, at body level, and never moved: moving an
// iframe reloads it, and a dedicated Worker ends with the document that made it — which this file
// reports as an error and turns into a refusal of every later call, never a hang.
//
// WHAT THE WORKER LETS US TIGHTEN, beyond closing the realm escape:
//   • THE BLOCK IS RAISED ONCE AND NEVER LOWERED. In the main realm it had to come down between
//     calls, because SillyTavern's own code runs there and legitimately needs `fetch` — which left
//     the documented microtask seam (`Promise.resolve().then(payload)` runs just after the restore).
//     Nothing but the engine runs in this Worker, so the block stays up for its whole lifetime and
//     that seam closes with it.
//   • THE HOST FACADE BECOMES DATA. The old facade handed the engine an object with live getters. A
//     Worker cannot read the main thread synchronously, so the three measured reads are SNAPSHOTTED and
//     sent with each call (snapshotSillyTavernForEngine / buildEngineHostSillyTavern, both in the block
//     module so the shape cannot drift between producer and consumer). That is the plan's own tier-3
//     rule applied literally: an engine that needs a fact should be GIVEN the fact, not an object it
//     can walk.
//   • NO REVERSE-RPC. An earlier draft of this file forwarded `root.saveStatData` back to the main
//     thread, on the strength of the engine's `__resolveTurn` wrapper awaiting it. That wrapper is the
//     CARD-STANDALONE path (the stat-menu iframe's local save); mvu-helper calls `resolveTurn` — the
//     pure function — and performs the MVU write itself in turn-runner.js. So the channel would have
//     shipped unexercised, and an unexercised channel out of an untrusted realm is a liability with no
//     offsetting use. Host services are default-denied by NAME here, same as globals: ask for one and
//     the request is rejected with the name in the message.
//
// COST, stated honestly: every engine call is async, with a structured clone each way, so its cost grows with the
// state (School v4's stat_data runs to a few hundred KB of JSON in a long chat). Card EJS call sites `await` —
// ST-Prompt-Template compiles templates with `async: true`, so that is supported, but it IS a card-contract break,
// chosen over a sync-fallback dual path because a fallback would leave the realm escape open on one branch and make
// the security claim depend on which branch ran.
//
// WHAT DOES NOT CHANGE — the same-reply guarantees this architecture exists to protect:
//   • Calls still happen DURING the render on the CURRENT stat_data, so `sweepCandidateLines` still
//     sees reply-0 state: no stash, no 1-reply lag, P8 same-round firing still fires this reply.
//   • RES remains the sole writer, and is now the sole writer more literally than before: the engine
//     has no write channel at all. `resolveTurn` computes on a CLONE and returns `{statData, applied,
//     log, resBlock}`; turn-runner.js applies the returned statData and calls Mvu.replaceMvuData, which
//     is exactly what it already did (the in-place mutation it also honoured is now simply the only
//     mechanism, since a clone's mutations cannot reach us any other way).
//   • The three read calls are read-only on their argument (verified: they only push to local
//     arrays), so passing a structured clone is equivalent to passing the live object.

import { createModuleLog } from '../../sillytavern/log.js';
import { extensionFolderPath } from '../../sillytavern/extension-paths.js';
import { ENGINE_WORKER_MODULES, ENGINE_FRAME_ATTRIBUTE, buildEngineFrameCsp, composeEngineFrameSrcdoc } from './engine-frame-core.js';
import { menuEngineExportsFromScope } from '../../shared/artifact-source-gates.js';

const log = createModuleLog('logic-engine');

// A file of this extension as an absolute URL.
function extensionUrl(path) {
    return new URL(`${extensionFolderPath}/${path}`, window.location.href).href;
}

// Modules the WORKER imports, by absolute URL, so both realms run the same code from the same files —
// one allow-list and one execution contract, not two that drift. A relative specifier cannot work here:
// the Worker's base URL is the blob, not our folder. Each one, and each module it imports, is listed by
// full path in the engine frame's policy (engine-frame-core.js ENGINE_WORKER_MODULES); one missing there
// is refused, and the Worker never starts.
function moduleUrl(fileName) {
    return extensionUrl(`src/features/logic-engine/${fileName}`);
}

// The Worker's whole program. Kept as a string because a Worker needs a URL and we will not ship a
// second copy of the engine contract as a separate file that can drift from this one.
//
// ORDER IS LOAD-BEARING. Everything the bootstrap itself needs is captured as a direct function
// reference BEFORE the block is raised — after that, `postMessage` and `addEventListener` are
// throwing stubs like everything else, and only these captured references still work. That capture is
// also what makes blocking them SAFE: the engine cannot post a message or listen for one, so the only
// traffic on this port is ours.
function workerSource(blockUrl, coreUrl) {
    return `
import { raiseEngineCapabilityBlockPermanently, getEngineCapabilityBlockReport,
         registerCapabilityBlockReporter, buildEngineHostSillyTavern } from ${JSON.stringify(blockUrl)};
import { executeEngineText, createEngineWorkerRuntime } from ${JSON.stringify(coreUrl)};

const post = self.postMessage.bind(self);
const onMessage = self.addEventListener.bind(self);

// A load the engine frame's policy refused — almost always an engine's dynamic import(). The load has
// already failed; this gives the refusal a line in the log naming what was asked for.
onMessage('securitypolicyviolation', (event) => post({ t: 'log', method: 'warn', args: [
    "the engine frame's Content-Security-Policy refused " + event.effectiveDirective + ' '
        + event.blockedURI + ' — engine code in this Worker cannot load from the network'] }));

registerCapabilityBlockReporter((message) => post({ t: 'log', method: 'warn', args: [message] }));

// RAISED ONCE, NEVER LOWERED — see the header. Nothing but the engines run in this Worker, so there
// is no legitimate consumer of the real globals to restore them for, and the microtask seam that
// forced a restore in the main realm closes with it.
// Everything below this line runs with every non-allowed global replaced by a throwing stub. The
// references captured at the top of this file (post, onMessage) still work — they are direct
// function references, not global lookups.
raiseEngineCapabilityBlockPermanently();

// The message loop itself is createEngineWorkerRuntime — imported, not re-typed, so the N-text
// contract (per-scope host isolation, per-text error containment, per-scope call routing) has exactly
// one definition and that definition is unit-tested (L6). The texts become code in there and nowhere
// else, with the block already up. A text logs through mvu-helper with MvuHelper.log (its lines reach
// the page as "[mvu-helper] [engine:<scope>] …"); console stays allowed too, and Chrome surfaces a
// dedicated Worker's console output in the page console (verified live 2026-08-06).
const runtime = createEngineWorkerRuntime({
    post,
    execute: executeEngineText,
    buildHost: buildEngineHostSillyTavern,
    getBlockReport: getEngineCapabilityBlockReport,
});

onMessage('message', (event) => runtime.handle(event.data || {}));
// No 'ready' handshake: messages posted to a Worker before its listener attaches are QUEUED by the
// browser, so startEngineWorker can send { t: 'load' } the instant it constructs the Worker and the
// bootstrap picks it up when the module finishes evaluating. A handshake would only add a round-trip.
`;
}

// The engine frame (header, WHERE THE WORKER IS BORN). One per page, shared by every Worker this file
// starts; a frame that died or moved is replaced, never revived.
let engineFrame = null;          // { element, window }
let engineFrameCreating = null;  // the creation in flight, shared by concurrent starts

const ENGINE_FRAME_GONE = 'the engine frame left the page (removed, or moved — moving an iframe '
    + 'reloads it), and the engine Worker ended with it. Engine calls are refused until the engine loads again '
    + '(re-open the chat)';

function engineFrameAlive(frame) {
    return !!frame && frame.element.isConnected && !frame.window.closed && frame.element.contentWindow === frame.window;
}

function ensureEngineFrame() {
    if (engineFrameAlive(engineFrame)) return Promise.resolve(engineFrame.window);
    if (!engineFrameCreating) engineFrameCreating = createEngineFrame().finally(() => { engineFrameCreating = null; });
    return engineFrameCreating;
}

async function createEngineFrame() {
    if (engineFrame) engineFrame.element.remove();
    engineFrame = null;
    const csp = buildEngineFrameCsp(ENGINE_WORKER_MODULES.map(extensionUrl));
    const element = document.createElement('iframe');
    element.setAttribute(ENGINE_FRAME_ATTRIBUTE, '');
    element.setAttribute('aria-hidden', 'true');
    element.tabIndex = -1;
    element.style.display = 'none';
    element.srcdoc = composeEngineFrameSrcdoc(csp);
    const frameWindow = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('logic-engine: the engine frame did not load within 10s')), 10000);
        element.addEventListener('load', function onFrameLoad() {
            // The srcdoc document, never the initial about:blank: only the srcdoc one carries the policy.
            if (!element.contentWindow || element.contentWindow.location.href !== 'about:srcdoc') return;
            clearTimeout(timer);
            element.removeEventListener('load', onFrameLoad);
            resolve(element.contentWindow);
        });
        document.body.appendChild(element);
    });
    const meta = frameWindow.document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    if (!meta || meta.getAttribute('content') !== csp) {
        element.remove();
        throw new Error('logic-engine: the engine frame loaded without its Content-Security-Policy — the engine is not started outside it');
    }
    frameWindow.addEventListener('pagehide', () => {
        if (current && current.frameWindow === frameWindow) current.end(ENGINE_FRAME_GONE);
    });
    engineFrame = { element, window: frameWindow };
    log.lifecycle(`engine frame ready — the engine Worker runs under: ${csp}`);
    return frameWindow;
}

// ONE REALM ON THIS SIDE. The Worker belongs to the frame, so its messages arrive as objects of the
// frame's realm: a page-side `instanceof` or prototype check fails on them, and they would outlive a
// frame that is gone. Every message is cloned into the page's realm here, before anything reads it.
function adoptMessage(event) {
    return structuredClone(event.data || {});
}

// One live Worker at a time — switching cards or reloading the engine terminates the old one.
let current = null;

export function terminateEngineWorker() {
    if (!current) return;
    try { current.worker.terminate(); } catch (e) { log.warn('worker terminate failed (continuing):', e); }
    // The frame made the blob URL; a frame that is gone took its URLs with it.
    if (!current.frameWindow.closed) current.frameWindow.URL.revokeObjectURL(current.url);
    for (const waiter of current.pending.values()) waiter.reject(new Error('logic-engine: the engine worker was terminated'));
    current = null;
}

/**
 * Start a Worker, load N engine texts into it (each in its own scope — §21), and return an async API.
 * @param {Array<{scope: string, code: string}>} texts the engine texts — ALL untrusted (the game's
 *   `[MVU_LogicEngine]` entry under GAME_ENGINE_SCOPE, plus one per installed plugin engine)
 * @param {object} bridge what the main thread offers the Worker (reads only — there is no write path)
 * @param {() => object} bridge.hostSnapshot the three measured reads, sampled per call
 * @param {() => object} [bridge.engineSnapshot] the hosted GameLogic engine's identity
 *   ({ name, type, version, packId, exposes }), sampled per call for the same reason: a captured copy
 *   would answer with the previous card's engine after a switch. Absent ⇒ the Worker facade answers
 *   all-null, which is the honest answer on a card that hosts no game engine.
 * @returns {Promise<{scopes: Object<string,{exports: string[], error: string}>, call: Function, report: object}>}
 *   `call(scope, name, args)` routes to one scope's export; a per-text eval error lands in that
 *   scope's `error`, never in the Promise — the CALLER decides which scope's failure is fatal.
 */
// The identity ride-along, read defensively: this is called on the path that boots and drives the
// engine, and a bridge that cannot answer must not take the engine down with it. A throw here would
// otherwise turn "we could not name the engine" into "the turn did not resolve".
function engineFacts(bridge) {
    if (!bridge || typeof bridge.engineSnapshot !== 'function') return null;
    try { return bridge.engineSnapshot(); }
    catch (e) { log.warn('the engine-identity snapshot threw — the Worker facade answers all-null this call:', e); return null; }
}

// The Worker's two imports, by absolute URL. Named once so every failure path can PRINT them: these
// specifiers are built as strings at runtime, so neither the test suite nor mytools/check-host-imports.mjs
// can see them (P7's documented blind spot) — and a 404 on either surfaces as a bare Worker `error` event
// with no URL in it. If the sync script ever stops copying this folder, the log line is the only thing
// that says so.
function workerImports() {
    return [moduleUrl('engine-capability-block.js'), moduleUrl('logic-engine-core.js')];
}

// A Worker made by the ENGINE FRAME — the blob URL and the Worker both — so it runs under the frame's
// policy (header, WHERE THE WORKER IS BORN). No path starts one from the page: a Worker the page made
// would run with no policy at all. A MODULE worker, because the bootstrap imports the shared capability
// block; classic workers cannot `import`, and importScripts() would need a second, non-module copy.
function makeFrameWorker(frameWindow, imports) {
    const source = workerSource(imports[0], imports[1]);
    const url = frameWindow.URL.createObjectURL(new frameWindow.Blob([source], { type: 'text/javascript' }));
    const worker = new frameWindow.Worker(url, { type: 'module' });
    return { url, worker };
}

// A `log` message from a Worker, routed to the page's log, where log.js gates it LIVE against
// extension_settings (the Worker never reads settings). The line names WHO wrote it. A message with a
// scope came from that scope's ENGINE TEXT through MvuHelper.log — `[engine:game]`, `[engine:plugin:<id>]`,
// `[engine:statusmenu]`, or `[engine:artifact-check]` for a throwaway check Worker, whose lines must not
// read as the running engine's; the engine's own tags (MvuHelper.log.child) follow. A message without a
// scope came from this extension's bootstrap code inside the Worker and prints as this module's. An
// unknown method degrades to a plain lifecycle line rather than being dropped — a log we cannot classify
// must still surface.
function routeWorkerLog(msg) {
    let target = msg.scope ? createModuleLog(`engine:${msg.scope}`) : log;
    for (const tag of (Array.isArray(msg.tags) ? msg.tags : [])) target = target.child(tag);
    const args = Array.isArray(msg.args) ? msg.args : [];
    switch (msg.method) {
        case 'error': target.error(...args); break;
        case 'warn': target.warn(...args); break;
        case 'lifecycle': target.lifecycle(...args); break;
        case 'verbose': target.verbose(...args); break;
        case 'trace': target.trace(...args); break;
        case 'domain': target.domain(msg.domain || 'pipeline', msg.level || 'lifecycle', ...args); break;
        default: target.lifecycle(...args); break;
    }
}

export async function startEngineWorker(texts, bridge) {
    terminateEngineWorker();
    const imports = workerImports();
    const frameWindow = await ensureEngineFrame();
    // A start that came in while the frame was being made has its own Worker by now; this, the later
    // one, replaces it — the same latest-start-wins as the terminate at the top of this function.
    terminateEngineWorker();
    const { url, worker } = makeFrameWorker(frameWindow, imports);
    const pending = new Map();
    let nextId = 1;
    // Why this Worker can no longer answer, once it cannot — set once, by end().
    let ended = null;
    const end = (reason) => {
        if (ended) return;
        ended = reason;
        log.error(reason);
        for (const waiter of pending.values()) waiter.reject(new Error(reason));
        pending.clear();
        if (current && current.worker === worker) current = null;
    };
    current = { worker, url, pending, frameWindow, end };

    worker.addEventListener('error', (e) => {
        // A Worker-level error is a load failure, not a call failure — nothing will ever answer, so
        // fail every waiter rather than let the turn hang on a promise that cannot settle. The module
        // URLs ride along because the overwhelmingly likely cause is one of them not being served, and
        // a module-worker fetch failure arrives with an empty `message`.
        log.error(`engine worker error: ${(e && e.message) || e || '(no message — usually a module that failed to load: a 404, or a module the engine frame\'s policy does not list in ENGINE_WORKER_MODULES)'}`
            + ` — the worker imports ${imports.join(' and ')}`);
        for (const waiter of pending.values()) waiter.reject(new Error(`logic-engine: worker error — ${(e && e.message) || e}`));
        pending.clear();
    });

    worker.addEventListener('message', (event) => {
        const msg = adoptMessage(event);
        if (msg.t === 'log') {
            routeWorkerLog(msg);
            return;
        }
        // There is deliberately NO inbound-service branch here. The engine cannot reach `postMessage`
        // (it is blocked like every other global — only the bootstrap's captured reference works), so
        // the only messages arriving on this port are the ones our own bootstrap sends. A "host service"
        // dispatcher would be a door with no key and no caller. See NO REVERSE-RPC in the header for
        // why `saveStatData` in particular is not one: mvu-helper owns the MVU write, in turn-runner.js.
        const waiter = pending.get(msg.id);
        if (!waiter) return;
        pending.delete(msg.id);
        if (msg.t === 'error') waiter.reject(Object.assign(new Error(msg.message), { engineStack: msg.stack }));
        else waiter.resolve(msg.value);
    });

    const loaded = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('logic-engine: the engine worker did not load within 10s — '
            + `it never answered the bootstrap, which usually means one of its modules 404'd or is missing from the engine frame's policy (ENGINE_WORKER_MODULES): ${imports.join(', ')}`)), 10000);
        const onLoad = (event) => {
            const msg = adoptMessage(event);
            if (msg.t !== 'loaded') return;
            clearTimeout(timer);
            worker.removeEventListener('message', onLoad);
            resolve(msg);
        };
        worker.addEventListener('message', onLoad);
        worker.postMessage({
            t: 'load',
            texts: (Array.isArray(texts) ? texts : []).map((t) => ({ scope: String(t.scope || ''), code: String(t.code || '') })),
            host: bridge.hostSnapshot(),
            engine: engineFacts(bridge),
        });
    });

    // The retired-worker refusal, shared by both call paths so their wording cannot drift. It names
    // the MECHANISM, not a caller: the host has no idea WHO replaced the engine (a pack install, a
    // library upgrade, the artifact dev loop's hot apply). Hard cutoff, never a retry on the new
    // worker — the call was aimed at the engine that was loaded when the turn started, and running
    // it against a different one would resolve the turn on code the turn was not built against.
    const RETIRED_WORKER = 'logic-engine: the engine was REPLACED while this call was in flight '
        + '(an engine reload — pack install/upgrade, or a dev-loop hot apply — retires the running worker), '
        + 'so the call was refused rather than run against a different engine than the turn started on';

    // Why a call cannot be sent: this Worker ended (its frame left the page — also caught here when the
    // frame went without a pagehide), or a newer Worker replaced it. null when it can be sent.
    const refusal = () => {
        if (!ended && frameWindow.closed) end(ENGINE_FRAME_GONE);
        if (ended) return ended;
        if (!current || current.worker !== worker) return RETIRED_WORKER;
        return null;
    };

    const call = (scope, name, args) => new Promise((resolve, reject) => {
        const refused = refusal();
        if (refused) { reject(new Error(refused)); return; }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ t: 'call', id, scope, name, args, host: bridge.hostSnapshot(), engine: engineFacts(bridge) });
    });

    // MANY calls, ONE round trip — the formatter pre-pass (§9.5). Resolves to one entry per request
    // ({ ok, value } | { ok:false, missing } | { ok:false, error }); the runtime contains per-call
    // failures, so this promise rejects only when the Worker itself is gone.
    const callBatch = (scope, calls) => new Promise((resolve, reject) => {
        const refused = refusal();
        if (refused) { reject(new Error(refused)); return; }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ t: 'callBatch', id, scope, calls, host: bridge.hostSnapshot(), engine: engineFacts(bridge) });
    });

    return { scopes: loaded.scopes || {}, report: loaded.report || {}, call, callBatch };
}

// ── the throwaway check Worker — what an artifact's engine exports, learned without the page running it ──
//
// The pack gates (shared/artifact-source-gates.js, G-C) check a StatusMenu layout against the engine
// beside it, and the only way to learn what a text exports is to run it. On the page it would run with the
// page's full reach — and the text comes from a ZIP or folder a user picked, or from a card someone shared.
// So it runs HERE: in a Worker of its own, made by the engine frame (same policy, same block, raised before
// the text runs), loaded once, read, and terminated. It is a SEPARATE Worker from the running engine's
// (`current`): a check never replaces, pauses or shares state with the engine a turn is using.
const ARTIFACT_CHECK_SCOPE = 'artifact-check';
const ARTIFACT_CHECK_LOAD_MS = 10000;

// Load one text in a fresh Worker and return that scope's load report — { exports, nestedExports,
// declared, error } — exactly as the running engine's load reports it. A text that throws at load comes
// back as `error`, like any engine; one that never returns from load comes back as `error` after
// ARTIFACT_CHECK_LOAD_MS. A Worker that cannot start at all, or a frame that left the page, REJECTS: that
// is the check failing, not a finding about the text.
export async function readEngineScopeInThrowawayWorker(code) {
    const imports = workerImports();
    const frameWindow = await ensureEngineFrame();
    const { url, worker } = makeFrameWorker(frameWindow, imports);
    try {
        const loaded = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(null), ARTIFACT_CHECK_LOAD_MS);
            worker.addEventListener('error', (e) => {
                clearTimeout(timer);
                reject(new Error(`logic-engine: the artifact check Worker failed to start: ${(e && e.message) || '(no message — usually a module that failed to load: a 404, or a module the engine frame\'s policy does not list in ENGINE_WORKER_MODULES)'}`
                    + ` — it imports ${imports.join(' and ')}`));
            });
            worker.addEventListener('message', (event) => {
                const msg = adoptMessage(event);
                if (msg.t === 'log') { routeWorkerLog(msg); return; }
                if (msg.t !== 'loaded') return;
                clearTimeout(timer);
                resolve(msg);
            });
            worker.postMessage({ t: 'load', texts: [{ scope: ARTIFACT_CHECK_SCOPE, code: String(code == null ? '' : code) }], host: null, engine: null });
        });
        if (!loaded) {
            if (frameWindow.closed) throw new Error(ENGINE_FRAME_GONE);
            return { exports: [], nestedExports: [], declared: null,
                error: `it did not finish loading within ${ARTIFACT_CHECK_LOAD_MS / 1000} s — a text that never returns from load hangs the engine Worker the same way` };
        }
        const scope = (loaded.scopes || {})[ARTIFACT_CHECK_SCOPE];
        if (!scope) throw new Error('logic-engine: the artifact check Worker answered without the checked scope');
        return scope;
    } finally {
        worker.terminate();
        if (!frameWindow.closed) frameWindow.URL.revokeObjectURL(url);
    }
}

// A StatusMenu Engine's formatter and action names, read in the throwaway Worker — the page's reader for
// the pack gates (gateArtifactSource's `menuEngineExports`).
export async function readMenuEngineExportsInWorker(engineText) {
    return menuEngineExportsFromScope(await readEngineScopeInThrowawayWorker(engineText));
}
