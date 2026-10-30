// logic-engine/engine-capability-block.js — what the UNTRUSTED engine text is allowed to touch.
//
// SCOPE, exactly (user, 2026-08-06): the only attacker-controlled input in this extension is the TEXT
// of the `[MVU_LogicEngine]` worldbook entry. Any user can edit it; a shared card can arrive with one
// already baked in. mvu-helper's own modules are ours and are NOT the subject here — this file is the
// DOOR that text walks through, nothing more.
//
// WHY A GLOBAL SWAP AND NOT PARAMETER SHADOWING (LOGIC_ENGINE_PLAN §11.1, probes run 2026-08-06):
// `executeEngineText` shadows module/exports/window/globalThis as function parameters. That was never
// a sandbox and never claimed to be — it exists so `root.*` exposures land on a private host. Measured:
// `Function('return this')()`, `(0,eval)('this')` and `[].constructor.constructor('return this')()` all
// walk straight back to the real global. Shadowing a NAME cannot help, because the escape does not use
// the name. So we swap the CAPABILITY on the real `globalThis` before engine code runs: escape all you
// like, the thing you reach is the stub. In the Worker that swap is raised ONCE and never lowered, so
// there is no window in which the real capability is back.
//
// DEFAULT-DENY, NOT A BLOCKLIST. We block every own global whose name is not in ALLOWED_GLOBALS, so a
// capability nobody thought of (a new `navigator.*`, some future exfil sink) is blocked by DEFAULT
// rather than by remembering to list it. The cost is that an engine needing something unforeseen fails
// LOUDLY with a named error instead of silently — which is the failure direction we want.
//
// WHAT THE REAL ENGINE ACTUALLY NEEDS (measured 2026-08-06 against School v4's 234KB bundle, the first
// consumer): `console` ×15, `crypto` ×1 (§9c rollPool), and the UMD dual-mode wrapper. ZERO hits for
// fetch · localStorage · sessionStorage · XMLHttpRequest · WebSocket · EventSource · indexedDB ·
// document · navigator. ZERO for setTimeout · setInterval · requestAnimationFrame · queueMicrotask.
// ZERO for `.then(` · `.catch(` · `new Promise`. One `async` function exists (`root.__resolveTurn`),
// and its single `await` is on `root.saveStatData` — a function WE inject. That measurement is what
// makes a hard block viable instead of a compromise.
//
// WHERE THIS RUNS NOW: INSIDE THE ENGINE WORKER (engine-worker-host.js), not on the page. That move is
// what makes the default-deny below an actual boundary rather than hardening, and it happened because
// two of the three residuals this header used to list were UNREACHABLE from the main realm. Measured
// live in Chrome on the real SillyTavern page, 2026-08-06 — the measurement that must be believed here,
// because Node has neither a `document` nor frames and therefore cannot show either one:
//   • `document` is a NON-CONFIGURABLE own accessor of `window` (WebIDL `[LegacyUnforgeable]`), exactly
//     like `location` and `top`. `defineProperty` cannot replace it, so the block never took `document`
//     away — and `document.createElement('iframe')` + append yields a FRESH REALM (verified:
//     `contentWindow.Object !== window.Object`) whose `fetch` and `localStorage` were never ours to swap.
//   • Child-frame WindowProxies are INDEXED own properties (`window[0]` … `window[N-1]`) and Blink
//     refuses to redefine an indexed property at all — see isFrameIndexName below. So a payload needed
//     no DOM either: SillyTavern had 12 live frames and `window[0].fetch` was a working function.
// Neither is a NAME, so no length of allow-list could ever have closed them. A Worker has no `document`,
// no frames, no `window.parent`, and no way to mint a realm — the escape has nowhere to land.
//
// WHAT REMAINS OPEN, stated at its real size (§11.5a):
//   • DYNAMIC `import()` IS NOT THIS FILE'S TO CLOSE — it is closed one layer out. It is SYNTAX, not a
//     global binding, so there is no name to swap: measured live in the Worker with the block fully up,
//     2026-08-06, `fetch` blocked and `await import('<any URL>')` still loaded. The Worker now starts
//     inside the ENGINE FRAME and runs under its Content-Security-Policy (engine-frame-core.js), which
//     lists no URL under `script-src`, so every `import()` that needs a request is refused before it is
//     made (live 2026-10-02: a remote URL, SillyTavern's own script.js, our own module with a query, and
//     a `data:` module, all refused). What `import()` still returns is the Worker's own module cache —
//     the four modules its bootstrap loaded, with no request. Nothing in them lowers this block; the one
//     thing they offered an engine, replacing this file's reporter to silence it, is locked by the
//     permanent raise (registerCapabilityBlockReporter). A text scan for `import(` would be theatre: the
//     specifier can be built at runtime.
//   • MICROTASK DEFERRAL is CLOSED here and was not before: the main realm had to restore the globals
//     between calls (SillyTavern's own code runs there and legitimately needs `fetch`), so
//     `Promise.resolve().then(payload)` landed just after the restore. Nothing but the engine runs in
//     the Worker, so raiseEngineCapabilityBlockPermanently() never lowers and there is no "after".
//
// Do not describe this file as a sandbox on its own. It is a default-deny on one realm's globals; the
// Worker is what makes that realm the ONLY realm the engine can see. Neither half is sufficient alone —
// a Worker still ships `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `indexedDB` and `caches`.
//
// PROTOTYPE CHAIN, NOT JUST OWN PROPERTIES (the hole the Worker mock test found, 2026-08-06). On `window`
// Blink installs the WebIDL members as OWN properties, so walking `getOwnPropertyNames(globalThis)` was
// enough. In a Worker it is NOT: `fetch`, `indexedDB`, `caches`, `importScripts`, `navigator`, `location`
// and `crypto` all live two prototypes up, on `WorkerGlobalScope.prototype`, while only the constructors
// (`XMLHttpRequest`, `WebSocket`, `Request`, `Response`, `EventSource`, `BroadcastChannel`) are own.
//
// SHADOWING THE PROTOTYPE WAS NOT ENOUGH EITHER (the walked-`fetch` hole, proven live 2026-09-18). An
// earlier build covered each inherited name with an own throwing stub on `globalThis`. That wins the NAME
// lookup (`globalThis.fetch`) but leaves the real function on `WorkerGlobalScope.prototype`, and
// `Object.getPrototypeOf(globalThis)` — a language builtin the engine must be allowed — walks straight to
// it: `Object.getPrototypeOf(self).fetch.call(self)` ran a real request to ST's backend with the block up.
// raise() now NEUTRALIZES the inherited capability IN PLACE on its owning prototype (replaces the
// descriptor with a throwing stub), so the name and the walk both resolve to the stub. The original is
// unrecoverable once replaced (it lived only there; engine code runs after the raise), so the stub stays
// `configurable` only so the Node suite's lower() can restore vitest's globals between tests.

// NO HOST IMPORTS BY DESIGN. `sillytavern/log.js` imports ST's extensions.js, which does not resolve in
// Node — and the one file that must be provable by TEST is this one, since its whole value is the
// claim "the demonstrated attack no longer works". So the logger arrives by REGISTRATION (P5, the
// repo's standard idiom): logic-engine-loader.js registers log.warn at import time, and the Node
// suite runs the attack against the real block with no logger attached.
// The two imports this door has are plain files with no host imports of their own: the settings
// namespace, a pinned cross-repo constant read from the one file that owns it, and the public settings
// rows the snapshot samples. The Worker loads both from this extension's folder, and
// ENGINE_WORKER_MODULES (engine-frame-core.js) lists them, because the engine frame's policy refuses
// any file it does not name.
import { EXTENSION_NAMESPACE } from '../../sillytavern/extension-paths.js';
import { PUBLIC_DEBUG_DOMAINS, publicSettingsSnapshot } from '../../shared/public-settings-core.js';

let reportBlockedAttempt = null;
// LOCKED BY THE PERMANENT RAISE. After it only engine code runs in this realm, and the modules the Worker
// loaded — this one included — stay reachable through `import()` from its module cache (the engine
// frame's policy refuses every import that would need a request, not one the cache answers). A
// registration after the raise can therefore only be engine code replacing the reporter, which would
// silence every BLOCKED line below. It is refused, counted, and said once through the reporter the
// Worker registered. One-way: there is no unlock, so an engine calling lockCapabilityBlockReporter()
// itself gains nothing.
let reporterLocked = false;
export function registerCapabilityBlockReporter(reporter) {
    if (reporterLocked) {
        noteRefusedReporter();
        return;
    }
    reportBlockedAttempt = (typeof reporter === 'function') ? reporter : null;
}
export function lockCapabilityBlockReporter() {
    reporterLocked = true;
}

// The JS LANGUAGE builtins — allowed because removing them does not remove a capability, it removes
// the ability to write JavaScript. `Function` and `eval` stay on purpose: blocking them buys nothing
// (`[].constructor.constructor` reaches the intrinsic without the global) and the whole design assumes
// the escape SUCCEEDS and finds stubs.
const LANGUAGE_BUILTINS = [
    'globalThis', 'undefined', 'NaN', 'Infinity',
    'Object', 'Function', 'Boolean', 'Symbol', 'Error', 'AggregateError', 'EvalError', 'RangeError',
    'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'Number', 'BigInt', 'Math', 'Date',
    'String', 'RegExp', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'ArrayBuffer', 'SharedArrayBuffer',
    'DataView', 'Atomics', 'JSON', 'WeakRef', 'FinalizationRegistry', 'Promise', 'Reflect', 'Proxy',
    'Intl', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
    'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
    'eval', 'isFinite', 'isNaN', 'parseFloat', 'parseInt',
    'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'unescape',
];

// The two host capabilities the engine genuinely uses. Anything added here is a deliberate widening of
// what an untrusted card can reach — state the measured call site in the comment, as these two do.
const MEASURED_ENGINE_NEEDS = [
    'console',   // ×15 in globalLogic — the [mvu-squad] pipeline trace
    'crypto',    // — dice in archived/baked engine builds (a v3 card's inline reject-sampled d20) and any
                 //   plugin resolver's PRIVATE randomness. The CURRENT School v4 engine carries no roller at
                 //   all ("DICE are NOT here", globalLogic header) — dice are dealt by mvu-helper's §9c
                 //   dealer at prompt time and reach resolvers as the verify-only ctx.dice receipt
                 //   (plans/rollPool-revisit.md); the allowlist entry stays for the older builds.
];

// Tier-1 PURE helpers (rule 1 below), allowed AHEAD of any measured call site (user, 2026-10-03): an
// engine author reaching for one of these must not need an mvu-helper release first. Each is
// deterministic, input to output, with no ambient state and no I/O.
const PURE_HELPERS = [
    'structuredClone',
    'TextEncoder',
    'TextDecoder',
    'atob',
    'btoa',
];

// ── HOW TO JUDGE A REQUEST TO WIDEN THIS (the rule, so it is not decided ad-hoc) ────────────────
// A logic engine is `stat_data` in, `stat_data` out — pure computation, and the ENTIRE computation
// surface of JavaScript is already allowed above. So a genre asking for a new global is asking for
// something a game mechanic does not structurally need, and the request gets sorted into one of three:
//
//   1. PURE — deterministic, input to output, no ambient state and no I/O. Safe to add: it hands an
//      attacker nothing they could not already write by hand in the allowed subset. The common five
//      are already in PURE_HELPERS; add another there.
//   2. AMBIENT READ — reads something about the user or the machine rather than the arguments.
//      `performance`, `navigator.language`, screen metrics. Push back first: the value is almost always
//      something mvu-helper can pass IN, and passing it in is both safer and more testable. (`Date` is
//      already allowed and is technically this tier — grandfathered, trivial, and unavoidable for a
//      calendar-driven genre.)
//   3. I/O OF ANY KIND — network, storage, DOM. Never widened, and the request is a design smell rather
//      than a need. The architectural answer already exists and is the one the codebase uses everywhere
//      else: the HOST injects it. `root.saveStatData` is exactly this — the engine does not go and
//      persist state, it is handed a function that does. `narrowSillyTavernFacade` below is the same
//      move for reads. An engine that needs a fact should be GIVEN the fact.
//
// The failure direction is deliberate: a genre that trips the block gets a named error plus a logged
// warning, so a legitimate need surfaces as a one-line request instead of a silent wrong branch.

const ALLOWED_GLOBALS = new Set([...LANGUAGE_BUILTINS, ...MEASURED_ENGINE_NEEDS, ...PURE_HELPERS]);

// Names we never try to touch even though they are not "allowed": swapping them either throws or
// breaks the page for reasons unrelated to security. `window`/`self`/`frames` are the global object
// under another name — the engine already gets those as shadowed PARAMETERS pointing at its private
// host, and redefining them on the real global is both refused by browsers and pointless.
const NEVER_TOUCH = new Set(['window', 'self', 'frames', 'globalThis']);

// Window's INDEXED own properties — `window[0]` … `window[N-1]`, one per child frame. They are NOT a
// capability we chose to allow; the browser flatly refuses to replace them:
//     Object.defineProperty(window, '0', { value: stub, … })
//     → "Failed to set an indexed property [0] on 'Window': Index property setter is not supported."
// and, unlike `location`/`top`/`parent`, they report `configurable: true`, so the configurability guard
// in raise() waves them straight through into that throw. Because integer-like keys sort FIRST in
// Object.getOwnPropertyNames, the throw landed on iteration one and took the whole engine load with it
// the moment SillyTavern had an iframe — live 2026-08-06, 12 frames (the card's TH-script--* /
// TH-message--* srcdoc frames): "load error — Failed to set an indexed property [0] on 'Window'".
// Skipped and recorded as unblockable, which is the honest label; see residual 3 in the header for what
// that costs us. Canonical array-index test (integer, no leading zeros, below 2^32-1) so a global that
// merely LOOKS numeric — `'0123'`, `'1e3'` — is still default-denied.
function isFrameIndexName(name) {
    return /^(0|[1-9]\d*)$/.test(name) && Number(name) < 4294967295;
}

let depth = 0;                       // re-entrancy: engine calling engine must not restore early
let savedDescriptors = null;         // OWN global name -> original descriptor, captured at depth 0
let neutralizedProto = null;         // INHERITED capability -> [{proto, name, original}] replaced IN PLACE on its
                                     //   owning prototype (restore = redefine the original descriptor)
const unblockableNames = new Set();  // non-configurable globals the swap could not replace
const blockedAttempts = Object.create(null);   // name -> how many times untrusted code reached for it
const reportedNames = new Set();               // names already surfaced ONCE (throttle, see noteAttempt)

// A blocked capability throws with a name in the message, because the engine wraps most host reads in
// `try { … } catch (_e) {}` (globalLogic's pipeDebugOn / latestReplyMsgId both do). Without a log at
// THROW time a blocked attempt would vanish into one of those swallows and we would learn nothing.
// Logged once per name per session — a determined payload in a loop must not flood the console.
function noteAttempt(name) {
    blockedAttempts[name] = (blockedAttempts[name] || 0) + 1;
    // Throttle on first REPORT, not first attempt. Keying it on "have we ever seen this name" loses the
    // message whenever an attempt lands before a reporter is attached — the name is marked seen, the
    // reporter registers, and that capability is never mentioned again for the rest of the session. A
    // security block whose only symptom is a silent throw is the failure mode we are trying to remove.
    if (reportBlockedAttempt && !reportedNames.has(name)) {
        reportedNames.add(name);
        reportBlockedAttempt(`BLOCKED — the engine text reached for \`${name}\`, which untrusted `
            + `engine code is not allowed to touch (LOGIC_ENGINE_PLAN §11). If this is a legitimate need for `
            + `your genre, it belongs in MEASURED_ENGINE_NEEDS, not in the engine.`);
    }
}

const REPORTER_REPLACEMENT = 'registerCapabilityBlockReporter';
function noteRefusedReporter() {
    blockedAttempts[REPORTER_REPLACEMENT] = (blockedAttempts[REPORTER_REPLACEMENT] || 0) + 1;
    if (reportBlockedAttempt && !reportedNames.has(REPORTER_REPLACEMENT)) {
        reportedNames.add(REPORTER_REPLACEMENT);
        reportBlockedAttempt('BLOCKED — engine code tried to replace the capability block\'s reporter, '
            + 'which would have silenced every BLOCKED line after it. The reporter stays the one the Worker registered.');
    }
}

// Callable stub: `typeof` still reports 'function' and the value is truthy, so the engine's own
// feature-detection (`typeof crypto !== 'undefined' && crypto.getRandomValues`) behaves normally
// instead of taking a weird branch. Only CALLING it fails, and it fails by name.
//
// Cached per name: raising the block replaces ~900 globals and happens on EVERY engine call
// (the card's EJS makes several per prompt render), so building fresh Proxies each time would be
// a few thousand throwaway allocations per turn for no gain — the stubs are stateless.
const stubCache = new Map();
function blockedFunction(name) {
    const cached = stubCache.get(name);
    if (cached) return cached;
    const stub = function () {
        noteAttempt(name);
        throw new Error(`logic-engine: \`${name}\` is blocked for uploaded engine code (LOGIC_ENGINE_PLAN §11)`);
    };
    // A payload may read a sub-API off it (`navigator.sendBeacon`, `document.createElement`). Reading
    // must fail too, or the reach only surfaces one frame later as a confusing `undefined is not a fn`.
    const blocked = new Proxy(stub, {
        get(_t, prop) {
            if (prop === Symbol.toPrimitive || prop === 'toString' || prop === Symbol.toStringTag) return undefined;
            noteAttempt(`${name}.${String(prop)}`);
            throw new Error(`logic-engine: \`${name}.${String(prop)}\` is blocked for uploaded engine code (LOGIC_ENGINE_PLAN §11)`);
        },
        set(_t, prop) {
            noteAttempt(`${name}.${String(prop)}=`);
            throw new Error(`logic-engine: writing \`${name}.${String(prop)}\` is blocked for uploaded engine code (LOGIC_ENGINE_PLAN §11)`);
        },
        apply() {
            noteAttempt(name);
            throw new Error(`logic-engine: \`${name}()\` is blocked for uploaded engine code (LOGIC_ENGINE_PLAN §11)`);
        },
        construct() {
            noteAttempt(`new ${name}`);
            throw new Error(`logic-engine: \`new ${name}()\` is blocked for uploaded engine code (LOGIC_ENGINE_PLAN §11)`);
        },
    });
    stubCache.set(name, blocked);
    return blocked;
}

// PASS ONE of the raise: every own property that WILL be stubbed, with the descriptor to restore.
// Exported so the read-then-write ordering can be tested against a Proxy — on globalThis the ordering
// is invisible, and it is the whole point of this function existing separately (L6).
// Non-configurable names are recorded as unblockable here, exactly as before.
export function captureBlockableDescriptors(target) {
    const captured = [];
    for (const name of Object.getOwnPropertyNames(target)) {
        if (ALLOWED_GLOBALS.has(name) || NEVER_TOUCH.has(name)) continue;
        if (isFrameIndexName(name)) { unblockableNames.add(name); continue; }
        const original = Object.getOwnPropertyDescriptor(target, name);
        if (!original || !original.configurable) {
            // `location`, `top`, `parent` and friends are non-configurable by spec — the swap CANNOT
            // replace them. Recorded rather than hidden: an honest report beats a false "blocked".
            if (original) unblockableNames.add(name);
            continue;
        }
        captured.push([name, original]);
    }
    return captured;
}

// Raise the block. Captures every own global it replaces so the restore is exact — we put back the
// original DESCRIPTOR, not a re-assignment, so getters stay getters and non-writables stay so.
function raise() {
    savedDescriptors = new Map();
    neutralizedProto = [];
    try {
        // (a) OWN globals — replace the property in place, keeping the descriptor for an exact restore.
        // Recomputed per raise, not cached at module load: SillyTavern and other extensions add globals
        // AFTER this module is evaluated, and a global that appears later must still be default-denied.
        //
        // READ EVERY DESCRIPTOR FIRST, THEN SWAP — two passes, never interleaved (2026-08-14). Reading a
        // global can RUN CODE: a LAZY global resolves its module on first inspection, and that module
        // uses other globals. Interleaved, the swap poisons the world the later reads happen in — Node's
        // `Object.getOwnPropertyDescriptor(globalThis, <lazy>)` loads a builtin that calls `Buffer.alloc`
        // and hits the stub the same loop installed ~40 names earlier, so raise() throws before the
        // engine ever runs. Found via a vitest upgrade, but nothing about it is test-only: any host that
        // defines a global behind an accessor (extensions do) is the same hazard in the browser.
        for (const [name, original] of captureBlockableDescriptors(globalThis)) {
            Object.defineProperty(globalThis, name, {
                value: blockedFunction(name), writable: true, enumerable: original.enumerable, configurable: true,
            });
            // Recorded only AFTER the swap succeeds. Recording first would make the rollback below try to
            // "restore" a property we never replaced — and for the property that just refused us, that
            // second defineProperty throws too, so the rollback would die on the way out.
            savedDescriptors.set(name, original);
        }
        // (b) INHERITED globals — the Worker's real capability set (see the PROTOTYPE CHAIN note in the
        // header: `fetch`, `indexedDB`, `caches`, `importScripts`, `navigator`, `location` and `crypto`
        // are all on WorkerGlobalScope.prototype, so loop (a) alone left `fetch` reachable and measured
        // "ALLOWED"). We NEUTRALIZE THE ORIGINAL IN PLACE on its owning prototype, we do NOT shadow it on
        // `globalThis`. A shadow only wins the NAME lookup (`globalThis.fetch`); it leaves the real
        // function sitting on the prototype, and `Object.getPrototypeOf(globalThis)` — a language builtin
        // we must allow — walks straight to it and calls it (proven live 2026-09-18: the walked `fetch`
        // reached ST's backend as the user with the block fully raised). Replacing the descriptor on the
        // prototype closes the walk: the name resolves to the stub AND the walk finds the stub, because
        // there is only one property and it is the stub. The original is UNRECOVERABLE afterwards — it
        // lived only here and engine code runs after the raise — so `configurable: true` (kept so the Node
        // suite's lower() can restore it) is not a tamper hole: `delete` leaves the name undefined, not the
        // capability. Walking stops at Object.prototype — its members are the language, not capability.
        const seenProto = new Set();
        for (let proto = Object.getPrototypeOf(globalThis); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
            for (const name of Object.getOwnPropertyNames(proto)) {
                if (ALLOWED_GLOBALS.has(name) || NEVER_TOUCH.has(name)) continue;
                // Already replaced by loop (a) as an OWN global (the constructors: XMLHttpRequest, WebSocket…).
                if (Object.prototype.hasOwnProperty.call(globalThis, name)) continue;
                if (seenProto.has(name)) continue;   // a nearer prototype already neutralized this name
                const original = Object.getOwnPropertyDescriptor(proto, name);
                // Native accessors/methods here are not lazy (unlike Node's globalThis builtins in loop (a)),
                // so reading the descriptor runs no code and the two-pass discipline of loop (a) is not needed.
                if (!original || !original.configurable) { if (original) unblockableNames.add(name); continue; }
                Object.defineProperty(proto, name, {
                    value: blockedFunction(name), writable: false, enumerable: original.enumerable, configurable: true,
                });
                neutralizedProto.push({ proto, name, original });
                seenProto.add(name);
            }
        }
    } catch (e) {
        // A refusal we did not predict must not leave the page HALF-BLOCKED. Everything swapped so far is
        // a throwing stub sitting on the real `globalThis`, and SillyTavern's own code — not the engine's —
        // runs on those the instant we return. Put them back, then rethrow so the loader still reports a
        // failed load (visible, fixable) instead of a silently degraded page (invisible, unfixable).
        // The indexed-frame case above kept this theoretical only by luck: integer keys sort first, so
        // that throw happened before a single real global had been replaced.
        lower();
        throw e;
    }
}

function lower() {
    if (!savedDescriptors && !neutralizedProto) return;
    const restoreFailures = [];
    for (const [name, original] of (savedDescriptors || [])) {
        // Per-name, because ONE failed restore must not strand every remaining global as a throwing stub.
        // Not a silent swallow: every failure is named in the report below and surfaced to the console.
        try { Object.defineProperty(globalThis, name, original); }
        catch (e) { restoreFailures.push(`${name} (${e && e.message || e})`); }
    }
    // Prototype neutralizations are undone by redefining the ORIGINAL descriptor on the same prototype
    // object we took it from — the inverse of the in-place replacement above. (The permanent Worker raise
    // never calls this; the Node suite does, so vitest gets its `fetch` back between tests.)
    for (const { proto, name, original } of (neutralizedProto || [])) {
        try { Object.defineProperty(proto, name, original); }
        catch (e) { restoreFailures.push(`${name} proto (${e && e.message || e})`); }
    }
    savedDescriptors = null;
    neutralizedProto = null;
    if (restoreFailures.length && reportBlockedAttempt) {
        reportBlockedAttempt(`could NOT restore ${restoreFailures.length} global(s) after the engine `
            + `call — these are still capability stubs and other page code will throw on them until reload: `
            + `${restoreFailures.join(', ')}`);
    }
}

// Run `fn` with the block up, then put every global back.
//
// PRODUCTION USES THE PERMANENT RAISE BELOW, NOT THIS. Nothing in mvu-helper evaluates engine text on
// the page any more — the loader starts a Worker — so the raise/lower pair has exactly two callers left,
// and both are load-bearing: raise()'s own rollback path, and the Node suite, which must be able to run
// the §11.1 payload against the REAL block and then hand vitest its globals back. Deleting it would mean
// the only tested path is one that can never be undone, i.e. a suite that can run the attack once.
// Re-entrant: an engine function calling another engine function must not lower on the inner return.
/** @internal */
export function runWithEngineCapabilityBlock(fn) {
    if (depth === 0) raise();
    depth += 1;
    try {
        return fn();
    } finally {
        depth -= 1;
        if (depth === 0) lower();
    }
}

// WORKER ONLY — raise the block and never lower it.
//
// In the main realm the block MUST come down between calls: SillyTavern's own code runs on those
// globals and legitimately needs `fetch`. That restore is what leaves residual 1, the microtask seam
// — `Promise.resolve().then(payload)` runs just after the synchronous block, so just after the
// restore. Inside the engine Worker nothing else runs at all, so there is no consumer to restore the
// globals FOR, and holding the block for the Worker's whole lifetime closes that seam completely.
//
// Depth is pinned above zero rather than set to a sentinel, so a later runWithEngineCapabilityBlock
// (the per-export wrap, if a Worker build ever keeps it) nests normally and still cannot lower.
// Imported by the engine Worker's bootstrap, which loads this file by URL (engine-worker-host.js workerSource).
/** @public */
export function raiseEngineCapabilityBlockPermanently() {
    if (depth > 0) return;      // already up — re-raising would discard the saved descriptors
    raise();
    depth = 1;
    lockCapabilityBlockReporter();
}

// wrapEngineExports() USED TO LIVE HERE and is deliberately gone. It re-raised the block around every
// exported function so that callers we do not control — the card's [PRE] EJS calls
// `globalThis.LogicEngine.initiativeMenu` / `previewNextBlock` / `sweepCandidateLines` directly
// (LOGIC_ENGINE_PLAN R5 option C) — were covered too. In the Worker build there is nothing to wrap: the
// only thing on `globalThis.LogicEngine` is a postMessage stub, the engine functions live behind a
// structured-clone boundary, and the block over there never comes down. A wrapper that raised the block
// on the PAGE would now protect nothing and would break SillyTavern for the duration of each call.

// ── the host snapshot, as DATA ────────────────────────────────────────────────
// Before the §11 work the loader bridged the WHOLE `window.SillyTavern` across — which handed untrusted
// code `getContext()` and with it the full chat, the character list, and `getRequestHeaders()`
// (same-origin calls to ST's backend AS THE USER). Blocking `fetch` while passing that object through
// would have been theatre.
//
// A Worker cannot read the main thread synchronously, so what the engine may know became a SNAPSHOT: the
// main thread samples plain values per call, they cross as structured-cloned data, and the Worker exposes
// them through the mvu-helper facade (logic-engine-core.js). That is the tier-3 rule applied literally —
// the engine is GIVEN the facts instead of an object it can walk.
//
// WHAT THE SNAPSHOT CARRIES NOW (and where it surfaces in the Worker):
//   • `messages` — a per-message projection {isUser, isSystem, swipeId}, NO text and NO author name.
//     Surfaced as `MvuHelper.messages` (find/latest/at/count), never as `SillyTavern.getContext().chat`
//     (that array is gone: it was a walkable object, and the one walk anyone did — latest non-user index
//     + swipe — is already handed to `resolveTurn` as the {mid,swipe} args).
//   • `settings` — `{ name: value }` for each public setting an engine may read
//     (shared/public-settings-core.js), read off real `extension_settings` on the page the way the page's
//     `MvuHelper.settings` reads them. Surfaced as `MvuHelper.settings.get(name)`.
//   • `logGate` — {verbosity, domains}, taken from those same settings. Surfaced ONLY as
//     `MvuHelper.log.enabled()/domainEnabled()` so an engine can guard an expensive preview; the log
//     methods themselves post to the page where the real `log.js` gates them live.
// `SillyTavern.extensionSettings` is BLANK in the Worker — what an engine may know of the settings is the
// named values above, so nothing settings-shaped is left in the untrusted realm.

/** Sample what the engine may know off the real `window.SillyTavern`. Main thread; returns plain data. */
export function snapshotSillyTavernForEngine(realSillyTavern) {
    if (!realSillyTavern) return null;
    let context = null;
    try { context = (typeof realSillyTavern.getContext === 'function') ? realSillyTavern.getContext() : null; }
    catch (e) {
        if (reportBlockedAttempt) reportBlockedAttempt(`SillyTavern.getContext() threw while snapshotting the engine host: ${e && e.message || e}`);
        return null;
    }
    // Per-message PROJECTION, not the live objects: only the role flags and the swipe. Indices are kept
    // aligned with the real chat (nulls stay null) because an index IS a message id; filtering would shift
    // them. The real `chat` carries every message body — structuredClone would copy all of it — so
    // narrowing here is what keeps message bodies out of the Worker rather than merely out of reach.
    const messages = Array.isArray(context && context.chat)
        ? context.chat.map((m) => (m ? { isUser: !!m.is_user, isSystem: !!m.is_system, swipeId: (m.swipe_id == null ? 0 : m.swipe_id) } : null))
        : undefined;
    const extensionSettings = context && context.extensionSettings;
    const settings = publicSettingsSnapshot(extensionSettings && extensionSettings[EXTENSION_NAMESPACE]);
    const domains = {};
    for (const name of PUBLIC_DEBUG_DOMAINS) domains[name] = settings['debug.' + name];
    return { messages, settings, logGate: { verbosity: settings['debug.verbosity'], domains } };
}

/** Rebuild the `root.SillyTavern` shape from a snapshot — deliberately EMPTY now. Worker side.
 *  Chat navigation moved to MvuHelper.messages (#3), the debug gate to MvuHelper.log (#2) and the settings
 *  an engine may read to MvuHelper.settings; the shape is kept so an engine's defensive
 *  `ST.getContext()?.chat` / `ST.extensionSettings` reads return undefined/{} instead of throwing. */
// Imported by the engine Worker's bootstrap, which loads this file by URL (engine-worker-host.js workerSource).
/** @public */
export function buildEngineHostSillyTavern(_snapshot) {
    const context = () => ({ extensionSettings: {} });
    return { getContext: context, get extensionSettings() { return {}; } };
}

// For the LogicEngine tab and the tests: what the block covered, what it could not cover, and what got
// reached for. `unblockable` being non-empty is not a defect to hide — it is the spec (non-configurable
// globals), and the tab should be able to say so rather than imply total coverage. `neutralized` is the
// prototype-chain count (the inherited capabilities replaced IN PLACE on their owning prototype),
// reported separately because a build where it reads 0 in a Worker is the regression that reopens the
// walked-`fetch` hole, and silence about it is how that regression would ship unnoticed.
// Imported by the engine Worker's bootstrap, which loads this file by URL (engine-worker-host.js workerSource).
/** @public */
export function getEngineCapabilityBlockReport() {
    return {
        replaced: savedDescriptors ? savedDescriptors.size : 0,
        neutralized: neutralizedProto ? neutralizedProto.length : 0,
        unblockable: [...unblockableNames].sort(),
        attempts: { ...blockedAttempts },
        allowed: [...ALLOWED_GLOBALS].sort(),
    };
}
