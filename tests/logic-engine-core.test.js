// tests/logic-engine-core.test.js — the R0 load contract (LOGIC_ENGINE_PLAN §5).
//
// Proves executeEngineText runs a wire_resolver-shaped bundle — dual-mode preludes followed by a
// globalLogic IIFE — capturing the engine API off module.exports and every root.* exposure on the
// PRIVATE host, with the real page globals untouched.
//
// The guards at the bottom run a REAL engine — the sibling game repo's workspace, assembled by
// mvu-helper's OWN assembler (schoolv4-artifact.mjs says why). They self-skip when that repo is not
// checked out next to this one (CI without the sibling).

import { describe, it, expect } from 'vitest';
import { haveSchoolv4, schoolv4EngineText } from './schoolv4-artifact.mjs';
// P9 B1: the fire verb is FORMAT-level, declared in event-pack-core — the guard below proves School honours it.
import { FIRE_INTENT } from '../src/features/event-pack/event-pack-core.js';
import { declaredNameOf } from '../src/shared/engine-header.js';
import { readEventContract, declaredIdentity, declaredVersionOf, executeEngineText, EVENT_PACK_PATH_FIELDS, createEngineWorkerRuntime, buildEngineInfoFacade, buildMvuHelperFacade, buildEngineLog, buildMessagesNavigator, buildEngineSettings, GAME_ENGINE_SCOPE, groupEngineNotesByKind, statusAfterUnreadableBook, engineScopeApi, engineStatusView } from '../src/features/logic-engine/logic-engine-core.js';

// Build { a: { b: leafObject } } from ['a','b'] — lets a fixture be spelled from the path the ENGINE
// declares instead of from a root name typed into this file.
const nest = (segs, leaf) => segs.reduceRight((inner, seg) => ({ [seg]: inner }), leaf);

// §B.7e.7 — what an engine text sees as `MvuHelper` INSIDE the Worker. The page and the Worker answer
// the same question under the same name; this is the Worker half, and it is pure.
describe('buildEngineInfoFacade — the Worker-side MvuHelper', () => {
    const FACTS = { name: 'School', type: 'School', version: 'v0.90.0', packId: 'school-v4', exposes: { 'cast@1': 'Classmate' } };

    it('hands over the five facts under the name the page uses', () => {
        expect(buildEngineInfoFacade(FACTS).engineInfo()).toEqual(FACTS);
    });

    it('PLAIN DATA, rebuilt per call — an engine that mutates what it got cannot poison the next read', () => {
        const facade = buildEngineInfoFacade(FACTS);
        const first = facade.engineInfo();
        first.name = 'Tampered';
        first.exposes['cast@1'] = 'Hijacked';
        delete first.type;
        expect(facade.engineInfo()).toEqual(FACTS);          // the second read is untouched
        expect(FACTS.exposes['cast@1']).toBe('Classmate');   // and so is the caller's own object
    });

    it('the facade itself cannot be re-pointed by the text it is handed to', () => {
        const facade = buildEngineInfoFacade(FACTS);
        expect(() => { facade.engineInfo = () => ({ name: 'Lie' }); }).toThrow();
        expect(facade.engineInfo().name).toBe('School');
    });

    it('NO engine hosted is a real card, not a hypothetical — all-null with an empty exposes', () => {
        for (const nothing of [null, undefined, {}]) {
            expect(buildEngineInfoFacade(nothing).engineInfo())
                .toEqual({ name: null, type: null, version: null, packId: null, exposes: {} });
        }
    });

    it('a pre-Engine-Type engine reads type null and keeps every other fact', () => {
        const old = buildEngineInfoFacade({ name: 'School', version: 'v0.88.0', packId: 'school-v4' }).engineInfo();
        expect(old.type).toBeNull();
        expect(old.name).toBe('School');
        expect(old.exposes).toEqual({});
    });

    it('a junk exposes value is not carried through as an object to walk', () => {
        expect(buildEngineInfoFacade({ exposes: 'nope' }).engineInfo().exposes).toEqual({});
    });
});

describe('executeEngineText — the bundle contract', () => {
    it('module.exports wins over prelude exports; root.* lands on the host, not real globals', () => {
        const bundle = [
            // a prelude in the i18n/eventpack UMD shape
            '(function (root, factory) {',
            '  var api = factory();',
            "  if (typeof module !== 'undefined' && module.exports) module.exports = api;",
            "  if (root && typeof root === 'object') root.__TEST_PRELUDE__ = api;",
            "})(typeof globalThis !== 'undefined' ? globalThis : this, function () { return { fromPrelude: true }; });",
            // a globalLogic-shaped IIFE that consumes the prelude off root
            '(function (root) {',
            "  function resolveTurn(sd) { return { sd: sd, prelude: root.__TEST_PRELUDE__.fromPrelude }; }",
            "  if (typeof module !== 'undefined' && module.exports) module.exports = { resolveTurn: resolveTurn };",
            "  if (root && typeof root === 'object') root.resolveTurn = resolveTurn;",
            "})(typeof window !== 'undefined' ? window : null);",
        ].join('\n');
        const host = {};
        const api = executeEngineText(bundle, host);
        expect(Object.keys(api)).toEqual(['resolveTurn']);          // globalLogic overwrote the prelude's exports
        expect(host.__TEST_PRELUDE__).toEqual({ fromPrelude: true });
        expect(host.resolveTurn).toBe(api.resolveTurn);
        expect(api.resolveTurn('x')).toEqual({ sd: 'x', prelude: true });   // engine reached the prelude via root
        expect(globalThis.__TEST_PRELUDE__).toBeUndefined();        // nothing leaked
        expect(globalThis.resolveTurn).toBeUndefined();
    });

    it('throws on a broken bundle (never a silent half-load)', () => {
        expect(() => executeEngineText('this is not js {{{', {})).toThrow();
    });
});

// ── a real engine (skips when the sibling repo is absent) ────────────────────
const haveV4 = haveSchoolv4();

describe.skipIf(!haveV4)('executeEngineText — a REAL assembled engine', () => {
    const bundle = schoolv4EngineText();

    it('loads and exposes the four School engine functions', () => {
        const host = {};
        const api = executeEngineText(bundle, host);
        for (const name of ['resolveTurn', 'i18nLabel', 'sweepCandidateLines', 'initiativeMenu']) {
            expect(typeof api[name], name).toBe('function');
        }
        expect(host.__I18N_API__).toBeTruthy();      // i18n prelude landed on the host
        expect(host.__EVENTPACK__).toBeTruthy();     // eventpack prelude too
        expect(globalThis.__EVENTPACK__).toBeUndefined();   // and stayed off the real globals
        expect(declaredVersionOf(bundle)).toMatch(/^v\d+\.\d+/);
    });
});

// ── createEngineWorkerRuntime — the N-text Worker's message loop (§21/§9.2, GP2) ─────────────
// The loop is extracted PURE so these decisions are testable at all (L6): per-scope isolation,
// per-text error containment, per-scope call routing. engine-worker-host.js imports this exact
// function into the Worker — what passes here is what runs there.

describe.skipIf(!haveV4)('P9 guards — a real engine (§5a)', () => {
    const bundle = schoolv4EngineText();

    it('the engine DECLARES both identity constants, as tokens a menu can match on', () => {
        // ENGINE_NAME and ENGINE_TYPE are the pair §B.7e.7 rests on. A real engine declaring only one
        // would leave `engineInfo().type` null on a card that plainly has a family, and every menu's
        // compatibility branch would read UNKNOWN forever without anything failing.
        const { name, type } = declaredIdentity(executeEngineText(bundle, {}));
        expect(name).toMatch(/^[A-Za-z0-9_.-]+$/);
        expect(type).toMatch(/^[A-Za-z0-9_.-]+$/);
    });
    it('the adapter carries NO applier and NO recorder — every write entry is data', () => {
        const { EVENT_PACK_ADAPTER: cfg } = executeEngineText(bundle, {});
        expect(cfg.recordFiredEvent).toBeUndefined();       // the library marks its own fires now
        expect(cfg.fx).toBeUndefined();                     // the applier map is gone, not shadowed
        expect(cfg.isPresent).toBeUndefined();              // Present() reads the declared presence path
        expect(typeof cfg.presence).toBe('string');
        expect(Array.isArray(cfg.writes)).toBe(true);
        for (const entry of cfg.writes) for (const v of Object.values(entry)) expect(typeof v).not.toBe('function');
    });
    it('a FIRE writes the done-marker and NO prose — the world log belongs to the narrator', () => {
        const host = {};
        const { EVENT_PACK_ADAPTER: cfg } = executeEngineText(bundle, host);
        const lib = host.__EVENTPACK__;
        const rootSegs = cfg.triggerRoot.split('.');
        const sd = nest(rootSegs, { k1: { cat: 'TRG', fx: { summary: 'a summary', scope: 'save' } } });
        const lines = [];
        expect(lib.applyEventFire(sd, 'k1', lines, cfg)).toBe(true);
        let node = sd; for (const x of rootSegs.slice(0, -1)) node = node[x];
        expect(node.fired.k1.state).toBe('done');
        expect(node.fired.k1.scope).toBe('save');            // the row's own word, stored verbatim
        expect(lib.evalOne(sd, 'flag:k1', cfg)).toBe(true);  // and the library reads it back
        // NOTHING was written into any genre store: the fire touched only the library root
        expect(Object.keys(sd).filter((k) => k !== rootSegs[0])).toEqual([]);
    });
    it('B1: School really does read the `eventFire` Intent channel the FORMAT fixes', () => {
        // Keeps "format-level" from being an untested assertion: a genre renaming its Intent channel
        // fails HERE instead of shipping packs whose bodies never commit (§5a.6).
        expect(bundle).toMatch(/\bI\.eventFire\b/);
        expect(FIRE_INTENT).toBe('eventFire');
    });

    it('the LIBRARY half names no applier and no genre path — writes are a rules engine over declarations', () => {
        // The defect the revisit closes: an fx type name (quest/npc/location) whose meaning lived in one
        // genre's applier. If a type name or a genre root comes back into the library half, this catches it.
        const start = bundle.indexOf('eventpack.cjs — the GENRE-NEUTRAL event engine');
        const end = bundle.indexOf('globalLogic.cjs — Window B resolver');
        expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
        const library = bundle.slice(start, end);
        expect(library).not.toMatch(/fx\.quest|fx\.npc|fx\.location|applyQuestFx|adapter\.fx\b/);
        expect(library).toMatch(/function applyWrites\(/);
    });
});

describe('createEngineWorkerRuntime (§21 N-text boot)', () => {
    const boot = (texts, snapshot = { chatLength: 1 }) => {
        const posted = [];
        const runtime = createEngineWorkerRuntime({
            post: (m) => posted.push(m),
            execute: executeEngineText,
            buildHost: (snap) => ({ snap }),
            getBlockReport: () => ({ replaced: 7 }),
        });
        runtime.handle({ t: 'load', texts, host: snapshot });
        return { posted, runtime, loaded: posted.find((m) => m.t === 'loaded') };
    };
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    // §B.7e.7 — the identity ride-along, END TO END through the loop that actually runs in the Worker.
    // The SPELLING is the thing to pin: an engine text reaches its host through `globalThis.` (School's
    // own engine reads `root.SillyTavern` the same way), so a bare `MvuHelper` is a ReferenceError, not
    // a fallback. Found by probe 2026-09-07 — the design note's example had the bare form.
    it('an engine text reads the hosted engine identity through globalThis.MvuHelper', async () => {
        const facts = { name: 'School', type: 'School', version: 'v0.90.0', packId: 'school-v4', exposes: { 'cast@1': 'Classmate' } };
        const posted = [];
        const runtime = createEngineWorkerRuntime({
            post: (m) => posted.push(m), execute: executeEngineText,
            buildHost: () => ({}), getBlockReport: () => ({}),
        });
        const menu = `module.exports = { line: () => {
            const e = globalThis.MvuHelper.engineInfo();
            return e.type + '/' + e.name + '/' + e.version + '/' + e.packId + '/' + Object.keys(e.exposes).join(',');
        } };`;
        runtime.handle({ t: 'load', texts: [{ scope: 'statusmenu', code: menu }], host: null, engine: facts });
        runtime.handle({ t: 'call', id: 1, scope: 'statusmenu', name: 'line', args: [], host: null, engine: facts });
        await flush();
        expect(posted.find((m) => m.id === 1).value).toBe('School/School/v0.90.0/school-v4/cast@1');
    });

    it('a bare `MvuHelper` is NOT reachable — the spelling above is the contract, not a convenience', async () => {
        const posted = [];
        const runtime = createEngineWorkerRuntime({
            post: (m) => posted.push(m), execute: executeEngineText,
            buildHost: () => ({}), getBlockReport: () => ({}),
        });
        runtime.handle({ t: 'load', texts: [{ scope: 'statusmenu', code: 'module.exports = { line: () => MvuHelper.engineInfo().name };' }], host: null, engine: { name: 'School' } });
        runtime.handle({ t: 'call', id: 1, scope: 'statusmenu', name: 'line', args: [], host: null, engine: { name: 'School' } });
        await flush();
        expect(posted.find((m) => m.id === 1).message).toMatch(/MvuHelper is not defined/);
    });

    it('EVERY scope gets the identity, and no scope can poison another\'s read', async () => {
        const facts = { name: 'School', type: 'School', version: 'v1', packId: 'p', exposes: {} };
        const posted = [];
        const runtime = createEngineWorkerRuntime({
            post: (m) => posted.push(m), execute: executeEngineText,
            buildHost: () => ({}), getBlockReport: () => ({}),
        });
        runtime.handle({ t: 'load', engine: facts, host: null, texts: [
            { scope: GAME_ENGINE_SCOPE, code: 'module.exports = { who: () => globalThis.MvuHelper.engineInfo().name };' },
            { scope: 'statusmenu', code: 'module.exports = { spoil: () => { const e = globalThis.MvuHelper.engineInfo(); e.name = "Tampered"; return "done"; } };' },
        ] });
        runtime.handle({ t: 'call', id: 1, scope: 'statusmenu', name: 'spoil', args: [], host: null, engine: facts });
        await flush();
        runtime.handle({ t: 'call', id: 2, scope: GAME_ENGINE_SCOPE, name: 'who', args: [], host: null, engine: facts });
        await flush();
        expect(posted.find((m) => m.id === 2).value).toBe('School');
    });

    it('a card hosting NO game engine answers all-null rather than throwing at the call site', async () => {
        const posted = [];
        const runtime = createEngineWorkerRuntime({
            post: (m) => posted.push(m), execute: executeEngineText,
            buildHost: () => ({}), getBlockReport: () => ({}),
        });
        const menu = 'module.exports = { line: () => { const e = globalThis.MvuHelper.engineInfo(); return String(e.type) + ":" + Object.keys(e.exposes).length; } };';
        runtime.handle({ t: 'load', texts: [{ scope: 'statusmenu', code: menu }], host: null, engine: null });
        runtime.handle({ t: 'call', id: 1, scope: 'statusmenu', name: 'line', args: [], host: null, engine: null });
        await flush();
        expect(posted.find((m) => m.id === 1).value).toBe('null:0');
    });

    it('boots N texts, reporting exports PER SCOPE', () => {
        const { loaded } = boot([
            { scope: GAME_ENGINE_SCOPE, code: 'module.exports = { resolveTurn: () => 1 };' },
            { scope: 'plugin:lane-probe', code: 'module.exports = { resolveRelay: () => 2 };' },
        ]);
        expect(loaded.scopes[GAME_ENGINE_SCOPE].exports).toEqual(['resolveTurn']);
        expect(loaded.scopes['plugin:lane-probe'].exports).toEqual(['resolveRelay']);
        expect(loaded.report).toEqual({ replaced: 7 });
    });

    it('one text throwing at eval is CONTAINED — its scope reports the error, the others still load', () => {
        const { loaded } = boot([
            { scope: GAME_ENGINE_SCOPE, code: 'module.exports = { resolveTurn: () => 1 };' },
            { scope: 'plugin:broken', code: 'throw new Error("boom at eval");' },
            { scope: 'plugin:fine', code: 'module.exports = { resolveRelay: () => 3 };' },
        ]);
        expect(loaded.scopes[GAME_ENGINE_SCOPE].error).toBe('');
        expect(loaded.scopes['plugin:broken'].error).toContain('boom at eval');
        expect(loaded.scopes['plugin:broken'].exports).toEqual([]);
        expect(loaded.scopes['plugin:fine'].exports).toEqual(['resolveRelay']);
    });

    it('each text gets its OWN host — root.* writes from one scope are invisible to every other', () => {
        const { runtime, posted } = boot([
            { scope: GAME_ENGINE_SCOPE, code: 'window.SECRET = "game-only"; module.exports = { read: () => window.SECRET };' },
            { scope: 'plugin:spy', code: 'module.exports = { read: () => window.SECRET };' },
        ]);
        runtime.handle({ t: 'call', id: 1, scope: 'plugin:spy', name: 'read', args: [], host: {} });
        runtime.handle({ t: 'call', id: 2, scope: GAME_ENGINE_SCOPE, name: 'read', args: [], host: {} });
        return flush().then(() => {
            const r1 = posted.find((m) => m.t === 'result' && m.id === 1);
            const r2 = posted.find((m) => m.t === 'result' && m.id === 2);
            expect(r1.value).toBeUndefined();       // isolation: the plugin cannot see the game's root
            expect(r2.value).toBe('game-only');
        });
    });

    it('calls route by scope, and an unknown scope or name errors by NAME instead of hanging', () => {
        const { runtime, posted } = boot([
            { scope: 'plugin:a', code: 'module.exports = { f: (x) => x + 1 };' },
        ]);
        runtime.handle({ t: 'call', id: 1, scope: 'plugin:a', name: 'f', args: [41], host: {} });
        runtime.handle({ t: 'call', id: 2, scope: 'plugin:none', name: 'f', args: [], host: {} });
        runtime.handle({ t: 'call', id: 3, scope: 'plugin:a', name: 'missing', args: [], host: {} });
        return flush().then(() => {
            expect(posted.find((m) => m.id === 1).value).toBe(42);
            expect(posted.find((m) => m.id === 2).message).toContain('plugin:none');
            expect(posted.find((m) => m.id === 3).message).toContain('missing');
        });
    });

    it('a throwing export lands on the error path with its message, same as a rejection', async () => {
        const { runtime, posted } = boot([
            { scope: 'plugin:a', code: 'module.exports = { die: () => { throw new Error("mid-call"); }, reject: () => Promise.reject(new Error("late")) };' },
        ]);
        runtime.handle({ t: 'call', id: 1, scope: 'plugin:a', name: 'die', args: [], host: {} });
        runtime.handle({ t: 'call', id: 2, scope: 'plugin:a', name: 'reject', args: [], host: {} });
        await flush();
        expect(posted.find((m) => m.id === 1).message).toContain('mid-call');
        expect(posted.find((m) => m.id === 2).message).toContain('late');
    });

    it('the snapshot facade reaches EVERY scope, and refreshes per call', () => {
        const { runtime, posted } = boot([
            { scope: GAME_ENGINE_SCOPE, code: 'module.exports = { see: () => window.SillyTavern.snap.chatLength };' },
            { scope: 'plugin:b', code: 'module.exports = { see: () => window.SillyTavern.snap.chatLength };' },
        ], { chatLength: 1 });
        runtime.handle({ t: 'call', id: 1, scope: 'plugin:b', name: 'see', args: [], host: { chatLength: 5 } });
        runtime.handle({ t: 'call', id: 2, scope: GAME_ENGINE_SCOPE, name: 'see', args: [], host: { chatLength: 5 } });
        return flush().then(() => {
            expect(posted.find((m) => m.id === 1).value).toBe(5);
            expect(posted.find((m) => m.id === 2).value).toBe(5);
        });
    });

    // A text logs through mvu-helper with MvuHelper.log; the page prints the line under
    // `[engine:<scope>]` plus the text's own tags — so the console can tell engines apart.
    it('a scope logs through MvuHelper.log: each line carries its scope and its own tags', () => {
        const { posted } = boot([
            { scope: 'plugin:noisy', code: 'window.MvuHelper.log.child("RES").warn("hello"); module.exports = {};' },
        ]);
        const line = posted.find((m) => m.t === 'log');
        expect(line).toMatchObject({ scope: 'plugin:noisy', method: 'warn', tags: ['RES'], args: ['hello'] });
    });
    // Until 2026-10-03 every host carried School v4's three logger names (root.squad/squadWarn/
    // squadError) — a first-consumer word in the platform's host contract.
    it('an Error argument arrives with its message — never as the "{}" JSON makes of it', () => {
        const { posted } = boot([
            { scope: 'game', code: 'window.MvuHelper.log.warn("resolve failed:", new Error("the clock is missing")); module.exports = {};' },
        ]);
        const line = posted.find((m) => m.t === 'log');
        expect(line.args[0]).toBe('resolve failed:');
        expect(line.args[1]).toContain('the clock is missing');
    });
    it('a host starts EMPTY — mvu-helper plants no logger names of its own on it', () => {
        const { posted } = boot([
            { scope: 'game', code: 'window.MvuHelper.log.warn(typeof window.squad, typeof window.squadWarn, typeof window.squadError); module.exports = {};' },
        ]);
        expect(posted.find((m) => m.t === 'log').args).toEqual(['undefined', 'undefined', 'undefined']);
    });
});

describe('groupEngineNotesByKind - each engine reported under the word its OWNER chose', () => {
    // The label has now been wrong twice: every non-game text was called a "plugin engine", and the
    // replacement bucketed them as "also hosted" - which still framed the StatusMenu Engine as
    // something adjacent to the game rather than as its display half. Both were flat lists, so both
    // were guaranteed to mislabel every member but the first. These pin the grouping.
    it('keeps a display engine and a plugin in SEPARATE clauses', () => {
        const grouped = groupEngineNotesByKind([
            { kind: 'display engine', note: 'statusmenu v1.0 [formatters.moneyDisplay]' },
            { kind: 'plugins', note: 'plugin:weather v2.0 [tick]' },
        ]);
        expect([...grouped.keys()]).toEqual(['display engine', 'plugins']);
        expect(grouped.get('display engine')).toEqual(['statusmenu v1.0 [formatters.moneyDisplay]']);
        expect(grouped.get('plugins')).toEqual(['plugin:weather v2.0 [tick]']);
    });

    it('never files the StatusMenu Engine under the plugin word', () => {
        const grouped = groupEngineNotesByKind([
            { kind: 'plugins', note: 'plugin:a v1 []' },
            { kind: 'display engine', note: 'statusmenu v1.0 []' },
            { kind: 'plugins', note: 'plugin:b v1 []' },
        ]);
        expect(grouped.get('plugins')).toEqual(['plugin:a v1 []', 'plugin:b v1 []']);
        expect(grouped.get('plugins').some((n) => n.startsWith('statusmenu'))).toBe(false);
        expect(grouped.get('display engine')).toEqual(['statusmenu v1.0 []']);
    });

    it('groups many plugins under ONE clause, in order', () => {
        const grouped = groupEngineNotesByKind([
            { kind: 'plugins', note: 'plugin:a v1 []' },
            { kind: 'plugins', note: 'plugin:b v1 []' },
        ]);
        expect(grouped.size).toBe(1);
        expect(grouped.get('plugins')).toEqual(['plugin:a v1 []', 'plugin:b v1 []']);
    });

    it('gives a kindless text a NEUTRAL bucket, never a word another kind owns', () => {
        const grouped = groupEngineNotesByKind([
            { kind: 'plugins', note: 'plugin:a v1 []' },
            { note: 'mystery v1 []' },
            { kind: '   ', note: 'blank v1 []' },
        ]);
        expect(grouped.get('plugins')).toEqual(['plugin:a v1 []']);
        expect(grouped.get('also hosted')).toEqual(['mystery v1 []', 'blank v1 []']);
    });

    it('is empty for no texts, so the clause vanishes instead of labelling nothing', () => {
        expect(groupEngineNotesByKind([]).size).toBe(0);
        expect(groupEngineNotesByKind(null).size).toBe(0);
    });
});

describe('statusAfterUnreadableBook (the unreadable-book status decision)', () => {
    // MUTATION TARGET — the live 2026-08-30 miss (ArtificKoi old chat). Plugins on an engine-less
    // card load as 'no-engine' with the Worker hosted; a chat switch hit the CHAT_CHANGED gap and
    // the old inline downgrade stamped 'book-not-ready', which both relay deciders read as "no
    // plugin lane", forever (the same-bytes reload cache never restores a status). Break the guard
    // — return 'book-not-ready' unconditionally — and this is the test that fails.
    it('keeps no-engine while the Worker still hosts plugin engines', () => {
        expect(statusAfterUnreadableBook('no-engine', true)).toBe('no-engine');
    });
    it('keeps loaded while the Worker still hosts the game engine', () => {
        expect(statusAfterUnreadableBook('loaded', true)).toBe('loaded');
    });
    it('degrades to book-not-ready when nothing is hosted', () => {
        expect(statusAfterUnreadableBook('disabled', false)).toBe('book-not-ready');
        expect(statusAfterUnreadableBook('error', false)).toBe('book-not-ready');
        expect(statusAfterUnreadableBook('no-engine', false)).toBe('book-not-ready');
    });
});

describe('engineStatusView — what the LogicEngine tab shows', () => {
    const ENGINE_HEADER = ["const ENGINE_NAME = 'Demo';", "const ENGINE_VERSION = 'v2.0.0';", ''].join('\n');
    const ENGINE_TEXT = ENGINE_HEADER + 'x'.repeat(2048 - ENGINE_HEADER.length);
    const INSTALLED = { found: true, text: ENGINE_TEXT };
    const COUNTERS = { liveResolved: 3, liveSaved: 2, fenceTripped: 1, refire: 0, foreignSkipped: 4 };
    const runnerParts = [{ text: 'Turn runner' }, { name: ':' }, { name: ' 3 ' }, { text: 'resolved' }, { name: ' · 2 ' }, { text: 'saved' },
        { name: ' · 1 ' }, { text: 'fence trips' }, { name: ' · 0 ' }, { text: 'refires' }, { name: ' · 4 ' }, { text: 'replays skipped' }];

    it('a running engine: named by what it declared, its exports, the stored copy and the turn runner', () => {
        const view = engineStatusView({ status: 'loaded', declared: { name: 'Game', version: 'v9' }, exports: ['resolveTurn', 'onPre'],
            installed: INSTALLED, counters: COUNTERS, isEnabled: true });
        expect(view.pill).toEqual({ text: 'Loaded', status: 'success' });
        expect(view.empty).toBeNull();
        expect(view.row.title).toEqual({ name: 'Game v9' });
        expect(view.row.sub).toEqual([
            { text: 'Exports', name: 'resolveTurn, onPre' },
            { text: 'Installed', name: 'v2.0.0 · 2.0 KB' },
            { parts: runnerParts },
        ]);
    });

    // The cold channel never names a RUNNING engine: its identity is what it declared at load.
    it('a running engine that declares nothing is unnamed, never named from its text', () => {
        const view = engineStatusView({ status: 'loaded', declared: { name: null, version: '' }, installed: INSTALLED });
        expect(view.row.title).toEqual({ text: 'Unnamed engine' });
    });

    it('switched off: the stored engine, named by its text, and no turn runner', () => {
        const view = engineStatusView({ status: 'disabled', installed: INSTALLED, counters: COUNTERS, isEnabled: false });
        expect(view.pill).toEqual({ text: 'Disabled', status: 'neutral' });
        expect(view.row).toEqual({ title: { name: 'Demo v2.0.0' }, sub: [{ text: 'Installed', name: 'v2.0.0 · 2.0 KB' }] });
    });

    it('a load error names the stored engine and carries the error', () => {
        const view = engineStatusView({ status: 'error', error: 'SyntaxError: x', installed: { found: true, text: 'garbage' }, isEnabled: true, counters: {} });
        expect(view.pill).toEqual({ text: 'Load error', status: 'danger' });
        expect(view.row.title).toEqual({ text: 'Unnamed engine' });
        expect(view.row.sub.slice(0, 2)).toEqual([{ text: 'Load error', name: 'SyntaxError: x' }, { text: 'Installed', name: '? · 0.0 KB' }]);
    });

    it('nothing to name: an empty state saying why', () => {
        const none = engineStatusView({ status: 'no-engine', installed: { found: false, text: '' }, isEnabled: true });
        expect(none.pill).toEqual({ text: 'No engine', status: 'warning' });
        expect(none.row).toBeNull();
        expect(none.empty.text).toBe('No engine on this card. Install a GameLogic Pack, or paste one below.');
        const unreadable = engineStatusView({ status: 'book-not-ready', installed: null });
        expect(unreadable.pill).toEqual({ text: 'Lorebook not ready', status: 'warning' });
        expect(unreadable.empty.text).toBe("The card's lorebook is not ready yet. Reload tries again.");
        expect(engineStatusView({ status: 'disabled', installed: { found: true, text: '  ' } }).empty.icon).toBe('fa-gears');
    });

    it('a state it does not know reads as a load error', () => {
        expect(engineStatusView({ status: 'exploded', installed: INSTALLED }).pill).toEqual({ text: 'Load error', status: 'danger' });
    });
});

// ── MvuHelper.log — the community logging contract (#2) ──────────────────────────────────────────
describe('buildEngineLog — the MvuHelper.log contract', () => {
    const capture = () => { const sent = []; return { post: (m) => sent.push(m), sent }; };
    const gate = { verbosity: 'verbose', domains: { pipeline: true, roster: false } };

    it('posts each method with its own kind, tagged by scope, args coerced clone-safe', () => {
        const { post, sent } = capture();
        const log = buildEngineLog(post, 'plugin:x', gate);
        log.error('boom', 7);
        log.warn('careful');
        log.lifecycle('up');
        log.verbose('per-batch');
        log.trace('per-item');
        log.domain('pipeline', 'trace', { a: 1 });
        expect(sent.map((m) => m.method)).toEqual(['error', 'warn', 'lifecycle', 'verbose', 'trace', 'domain']);
        expect(sent.every((m) => m.t === 'log' && m.scope === 'plugin:x')).toBe(true);
        expect(sent[0].args).toEqual(['boom', 7]);           // primitives ride as-is
        expect(sent[5].args).toEqual(['{"a":1}']);           // objects serialise for readability
        expect(sent[5].domain).toBe('pipeline');
        expect(sent[5].level).toBe('trace');
    });

    it('domain() defaults to pipeline/lifecycle when the engine omits them', () => {
        const { post, sent } = capture();
        buildEngineLog(post, 'game', gate).domain(undefined, undefined, 'x');
        expect(sent[0]).toMatchObject({ method: 'domain', domain: 'pipeline', level: 'lifecycle' });
    });

    it('enabled() and domainEnabled() answer from the sampled gate — the guard for expensive previews', () => {
        const log = buildEngineLog(() => {}, 'game', gate);
        expect(log.enabled('lifecycle')).toBe(true);
        expect(log.enabled('verbose')).toBe(true);
        expect(log.enabled('trace')).toBe(false);   // gate is 'verbose', below trace
        expect(log.domainEnabled('pipeline')).toBe(true);
        expect(log.domainEnabled('roster')).toBe(false);
        expect(log.domainEnabled('never-declared')).toBe(false);
    });

    it('an absent gate reads as everything-off, and a throwing post never reaches the engine', () => {
        const off = buildEngineLog(() => {}, 'game', undefined);
        expect(off.enabled('lifecycle')).toBe(false);
        expect(off.domainEnabled('pipeline')).toBe(false);
        const throwing = buildEngineLog(() => { throw new Error('port gone'); }, 'game', gate);
        expect(() => throwing.verbose('x')).not.toThrow();   // a logger must not take the turn down
    });
});

// ── MvuHelper.messages — content-free navigation (#3) ────────────────────────────────────────────
describe('buildMessagesNavigator — the MvuHelper.messages contract', () => {
    // index:            0        1          2         3            4
    const messages = [
        { isUser: true, isSystem: false, swipeId: 0 },   // user
        { isUser: false, isSystem: false, swipeId: 2 },  // assistant
        { isUser: false, isSystem: true, swipeId: 0 },   // system
        null,                                            // a hole — index stays aligned
        { isUser: false, isSystem: false, swipeId: 1 },  // assistant
    ];

    it('maps flags to SillyTavern roles exactly as ST derives them', () => {
        const nav = buildMessagesNavigator(messages);
        expect(nav.at(0).role).toBe('user');
        expect(nav.at(1).role).toBe('assistant');
        expect(nav.at(2).role).toBe('system');
        expect(nav.at(4)).toEqual({ index: 4, role: 'assistant', swipeId: 1 });
    });

    it('latest(role) finds the newest of a role; omitting role means any', () => {
        const nav = buildMessagesNavigator(messages);
        expect(nav.latest('assistant').index).toBe(4);
        expect(nav.latest('user').index).toBe(0);
        expect(nav.latest('system').index).toBe(2);
        expect(nav.latest().index).toBe(4);           // any → the last real message
    });

    it('find walks either direction, honors from and skip, and returns null when nothing matches', () => {
        const nav = buildMessagesNavigator(messages);
        expect(nav.find({ role: 'assistant', direction: 'backward' }).index).toBe(4);
        expect(nav.find({ role: 'assistant', from: 3, direction: 'backward' }).index).toBe(1);
        expect(nav.find({ role: 'user', direction: 'forward' }).index).toBe(0);
        expect(nav.find({ role: 'assistant', direction: 'forward', skip: 1 }).index).toBe(4);
        expect(nav.find({ role: 'system', from: 1, direction: 'backward' })).toBeNull();
    });

    it('count(role) counts matches; a null hole is never a message; at() takes negative indices', () => {
        const nav = buildMessagesNavigator(messages);
        expect(nav.count()).toBe(4);                  // 4 real, the null hole excluded
        expect(nav.count('assistant')).toBe(2);
        expect(nav.count('user')).toBe(1);
        expect(nav.at(-1).index).toBe(4);             // last
        expect(nav.at(3)).toBeNull();                 // the hole
    });

    it('an absent projection is an empty navigator, not a crash', () => {
        const nav = buildMessagesNavigator(undefined);
        expect(nav.count()).toBe(0);
        expect(nav.latest('assistant')).toBeNull();
        expect(nav.find({ role: 'user' })).toBeNull();
        expect(nav.at(0)).toBeNull();
    });
});

// ── MvuHelper.settings — the settings an engine may read, by name ────────────────────────────────
describe('buildEngineSettings — the Worker-side MvuHelper.settings contract', () => {
    const capture = () => { const sent = []; return { log: buildEngineLog((m) => sent.push(m), 'game', undefined), sent }; };
    const values = { 'debug.verbosity': 'verbose', 'debug.pipeline': true, language: 'en' };

    it('get answers the sampled value; names lists what was sampled', () => {
        const settings = buildEngineSettings(values, capture().log);
        expect(settings.get('debug.pipeline')).toBe(true);
        expect(settings.get('debug.verbosity')).toBe('verbose');
        expect(settings.names()).toEqual(['debug.verbosity', 'debug.pipeline', 'language']);
        expect(Object.isFrozen(settings)).toBe(true);
    });
    it('an unknown name answers undefined and warns once, naming the settings; a prototype key is unknown too', () => {
        const { log, sent } = capture();
        const settings = buildEngineSettings(values, log);
        expect(settings.get('extensionSettings')).toBeUndefined();
        expect(settings.get('extensionSettings')).toBeUndefined();
        expect(settings.get('__proto__')).toBeUndefined();
        const warns = sent.filter((m) => m.method === 'warn');
        expect(warns).toHaveLength(2);
        expect(warns[0].args[0]).toContain('debug.pipeline');
    });
    it('MUTATION TARGET — set writes nothing and says why: an engine sets no setting', () => {
        const { log, sent } = capture();
        const settings = buildEngineSettings(values, log);
        expect(settings.set('debug.pipeline', false)).toBe(false);
        expect(settings.get('debug.pipeline')).toBe(true);
        expect(values['debug.pipeline']).toBe(true);
        expect(sent.filter((m) => m.method === 'warn')).toHaveLength(1);
    });
    it('no sampled values (an empty host) is an empty door, not a crash', () => {
        const settings = buildEngineSettings(undefined, capture().log);
        expect(settings.names()).toEqual([]);
        expect(settings.get('debug.pipeline')).toBeUndefined();
    });
});

describe('buildMvuHelperFacade — identity + log + messages + settings on one frozen object', () => {
    it('exposes engineInfo, log, messages and settings, and is frozen', () => {
        const facade = buildMvuHelperFacade({
            engine: { name: 'School', version: 'v9', exposes: { Mainchar: 'x' } },
            snapshot: {
                logGate: { verbosity: 'trace', domains: { pipeline: true } },
                messages: [{ isUser: false, isSystem: false, swipeId: 0 }],
                settings: { 'debug.pipeline': true },
            },
            scope: 'game',
            post: () => {},
        });
        expect(facade.engineInfo().name).toBe('School');
        expect(facade.log.domainEnabled('pipeline')).toBe(true);
        expect(facade.messages.latest('assistant').index).toBe(0);
        expect(facade.settings.get('debug.pipeline')).toBe(true);
        expect(Object.isFrozen(facade)).toBe(true);
    });
});

// ── the DECLARED identity: what replaces every header parse ──────────────────
describe('declaredIdentity — what an engine says about itself, read from the evaluated module', () => {
    const FULL = {
        ENGINE_VERSION: 'v0.107.0', ENGINE_NAME: 'School', ENGINE_TYPE: 'School',
        EVENT_PACK_FORMAT: '1.2', EVENT_PACK_ADAPTER: { writes: [{ path: 'Mainchar.Quests' }] },
        resolveTurn: () => {},
    };

    it('picks up all five declarations and nothing else', () => {
        const d = declaredIdentity(FULL);
        expect(d.version).toBe('v0.107.0');
        expect(d.name).toBe('School');
        expect(d.type).toBe('School');
        expect(d.eventPack.format).toBe('1.2');
        expect(d.eventPack.writes[0].path).toBe('Mainchar.Quests');
        expect(d.resolveTurn).toBeUndefined();          // the API is not identity
    });

    it('an engine that declares nothing reports UNKNOWN, never a guess', () => {
        const d = declaredIdentity({ resolveTurn: () => {} });
        expect(d).toEqual({ version: null, name: null, type: null, eventPack: null });
    });

    it('a NON-STRING declaration is dropped, never coerced', () => {
        // String(undefined) would report the literal word "undefined" as an engine's version, which
        // reads as a real answer. Same for a computed value that did not resolve to a string.
        const d = declaredIdentity({ ENGINE_VERSION: undefined, ENGINE_NAME: 42, ENGINE_TYPE: {} });
        expect(d).toEqual({ version: null, name: null, type: null, eventPack: null });
    });

    it('an empty-string declaration is UNKNOWN, not an empty version', () => {
        expect(declaredIdentity({ ENGINE_VERSION: '' }).version).toBeNull();
    });

    it('a non-object adapter is refused rather than carried as a shape nobody can read', () => {
        expect(declaredIdentity({ EVENT_PACK_ADAPTER: 'nope' }).eventPack).toBeNull();
        expect(declaredIdentity({ EVENT_PACK_ADAPTER: [] }).eventPack).toBeNull();
    });

    it('CARRIES NO FUNCTIONS — an adapter hook must never reach postMessage', () => {
        // THE REGRESSION THIS GUARDS (broke the live card 2026-09-18): EVENT_PACK_ADAPTER mixes data with the
        // engine's own hooks. Copying the object whole threw `(sd) => nowStamp(sd) could not be cloned`
        // on postMessage, so the worker never answered its bootstrap and the engine — and the StatusMenu
        // behind it — failed to load entirely.
        const d = declaredIdentity({
            EVENT_PACK_ADAPTER: {
                triggerRoot: 'EventPack.triggers', armedPath: 'Derived.Armed',
                writes: [{ path: 'A.B' }], rewards: [{ name: 'stat' }], scopes: ['save'],
                nowStamp: (sd) => sd, get: () => 1, setArmed: () => 2, warn: () => 3,
            },
        });
        expect(JSON.stringify(d)).toBeTruthy();                       // survives a clone at all
        expect(structuredClone(d)).toBeTruthy();                      // and the REAL boundary
        expect(d.eventPack.triggerRoot).toBe('EventPack.triggers');
        expect(d.eventPack.scopes).toEqual(['save']);
        for (const key of ['nowStamp', 'get', 'setArmed', 'warn']) expect(d.eventPack[key]).toBeUndefined();
    });

    it('carries the declared bodyEntry across, and reports an undeclared one as null', () => {
        const slot = { position: 'at_depth_as_system', depth: 0, order: 750 };
        expect(declaredIdentity({ EVENT_PACK_ADAPTER: { bodyEntry: slot } }).eventPack.bodyEntry).toEqual(slot);
        expect(declaredIdentity({ EVENT_PACK_ADAPTER: { writes: [] } }).eventPack.bodyEntry).toBeNull();
        // A malformed one crosses as declared, so the contract reader can refuse it by name.
        expect(declaredIdentity({ EVENT_PACK_ADAPTER: { bodyEntry: 'depth0' } }).eventPack.bodyEntry).toBe('depth0');
    });

    it('declaring only ONE half of the event contract still reports that half', () => {
        expect(declaredIdentity({ EVENT_PACK_FORMAT: '1.2' }).eventPack).toEqual({ format: '1.2' });
        expect(declaredIdentity({ EVENT_PACK_ADAPTER: { writes: [] } }).eventPack.format).toBeNull();
    });

    it('junk in, no throw', () => {
        expect(declaredIdentity(null).version).toBeNull();
        expect(declaredIdentity(undefined).eventPack).toBeNull();
    });
});

describe('declaredVersionOf / declaredNameOf — the COLD channel, for text that is not running', () => {
    it('reads the declaration wherever it sits — NO leading-byte window', () => {
        // THE REGRESSION THIS GUARDS. globalLogic declares its identity past 5600 bytes, below a long
        // banner. The retired parseEngineVersion capped at 4000 and would report this engine as having
        // no version at all. A platform cannot dictate where an author writes a line in their own file.
        const text = '// '.repeat(3000) + "\nconst ENGINE_VERSION = 'v0.107.0';\n";
        expect(text.indexOf('ENGINE_VERSION')).toBeGreaterThan(4000);
        expect(declaredVersionOf(text)).toBe('v0.107.0');
    });

    it('accepts var / let / const and leading indentation', () => {
        expect(declaredVersionOf("  const ENGINE_VERSION = 'v1.0';")).toBe('v1.0');
        expect(declaredVersionOf('var ENGINE_VERSION = "v2.0";')).toBe('v2.0');
        expect(declaredVersionOf("\tlet ENGINE_VERSION = 'v3.0';")).toBe('v3.0');
    });

    it('a bare version marker in a comment is NOT a declaration', () => {
        // The whole point of the switch: the old reader took any `vN.N` in the header, so a version in
        // prose could answer for the engine. Only the named declaration counts now.
        expect(declaredVersionOf('/* globalLogic — the resolver. v0.106.0 */')).toBeNull();
        expect(declaredVersionOf('// ── THE KEYED MICROFORMAT (v0.49.0) ──')).toBeNull();
    });

    it('an indirection is refused — it cannot be read from source, by design', () => {
        expect(declaredVersionOf('const ENGINE_VERSION = buildVersion();')).toBeNull();
    });

    it('reads the name by the same grammar', () => {
        expect(declaredNameOf("const ENGINE_NAME = 'School';")).toBe('School');
    });

    it('absent declaration and junk both read as null, never as a guess', () => {
        expect(declaredVersionOf('module.exports = {};')).toBeNull();
        expect(declaredVersionOf('')).toBeNull();
        expect(declaredVersionOf(null)).toBeNull();
    });
});

describe('the worker REPORTS declared identity per scope', () => {
    const load = (texts) => {
        const posted = [];
        const runtime = createEngineWorkerRuntime({
            post: (m) => posted.push(m), execute: executeEngineText,
            buildHost: () => ({}), getBlockReport: () => ({}),
        });
        runtime.handle({ t: 'load', texts, host: null, engine: {} });
        return posted.find((m) => m.t === 'loaded').scopes;
    };

    it('carries the engine\'s own declarations out of the Worker', () => {
        const code = `const ENGINE_VERSION = 'v0.107.0';
            const ENGINE_NAME = 'School';
            const ENGINE_TYPE = 'School';
            module.exports = { ENGINE_VERSION, ENGINE_NAME, ENGINE_TYPE,
                EVENT_PACK_FORMAT: '1.2', EVENT_PACK_ADAPTER: { writes: [{ path: 'A.B' }] },
                resolveTurn: () => 1 };`;
        const scopes = load([{ scope: GAME_ENGINE_SCOPE, code }]);
        expect(scopes[GAME_ENGINE_SCOPE].declared.version).toBe('v0.107.0');
        expect(scopes[GAME_ENGINE_SCOPE].declared.name).toBe('School');
        expect(scopes[GAME_ENGINE_SCOPE].declared.eventPack.format).toBe('1.2');
        // The adapter crosses as DATA, not a proxy — it must survive a structured clone.
        expect(structuredClone(scopes[GAME_ENGINE_SCOPE].declared).eventPack.writes[0].path).toBe('A.B');
    });

    it('does NOT disturb the export lists every existing consumer reads', () => {
        const code = `module.exports = { ENGINE_VERSION: 'v1.0', resolveTurn: () => 1,
            formatters: { money: () => 2 }, EVENT_PACK_ADAPTER: { writes: [] } };`;
        const s = load([{ scope: GAME_ENGINE_SCOPE, code }])[GAME_ENGINE_SCOPE];
        // Only FUNCTIONS are exports; the declarations are not callable and must not appear here.
        expect(s.exports).toEqual(['resolveTurn']);
        expect(s.nestedExports).toEqual(['formatters.money']);
    });

    it('reports declarations PER SCOPE — a standalone plugin on a bare card still has its own version', () => {
        const scopes = load([
            { scope: 'plugin:weather', code: "module.exports = { ENGINE_VERSION: 'v0.7', resolveRelay: () => 1 };" },
            { scope: 'statusmenu', code: "module.exports = { ENGINE_VERSION: 'v1.2', render: () => 1 };" },
        ]);
        expect(scopes['plugin:weather'].declared.version).toBe('v0.7');
        expect(scopes['statusmenu'].declared.version).toBe('v1.2');
        expect(scopes['plugin:weather'].declared.eventPack).toBeNull();   // not a game engine
    });

    it('a scope that FAILED to evaluate declares nothing — never a stale or invented identity', () => {
        const scopes = load([{ scope: 'plugin:broken', code: 'throw new Error("boom");' }]);
        expect(scopes['plugin:broken'].error).toMatch(/boom/);
        expect(scopes['plugin:broken'].declared).toBeNull();
    });
});


// ── readEventContract — the ONE verdict reader the event-pack gate uses ────────────────────────
// It replaced five header parsers across four call sites. The point of these tests is that the
// SEMANTICS each parser carried survive the move: which failures are fatal, which are warnings, and
// which absence is a real answer rather than a fault.
describe('readEventContract — three states, three different fixes', () => {
    const adapter = {
        triggerRoot: 'EventPack.triggers',
        armedPath: 'EngineDerived.EventArmed',
        writes: [{ path: 'Mainchar.Quests', ownerStamp: 'GrantedBy' }],
        rewards: [{ name: 'stat', path: 'Mainchar', fields: ['Int'], max: 8 }],
        scopes: ['once', 'always'],
        format: '1.2',
    };
    const declared = (eventPack) => ({ version: 'v0.107.0', name: 'School', type: 'School', eventPack });

    it('NO ENGINE ⇒ every verdict refuses, and the reason says so — not "malformed"', () => {
        const r = readEventContract(null);
        expect(r.paths.ok).toBe(false);
        expect(r.paths.reason).toMatch(/no logic engine is loaded/);
        // All four carry the SAME reason: one fault, not four separate ones to chase.
        for (const k of ['writes', 'rewards', 'scopes']) expect(r[k].reason).toBe(r.paths.reason);
        expect(r.format).toBe('');
    });

    it('an engine that declares NO adapter is a DIFFERENT fault from no engine', () => {
        const r = readEventContract(declared(null));
        expect(r.paths.ok).toBe(false);
        expect(r.paths.reason).toMatch(/declares no EVENT_PACK_ADAPTER/);
        expect(r.paths.reason).not.toMatch(/no logic engine is loaded/);
    });

    it('a complete adapter answers every verdict, and carries the format through', () => {
        const r = readEventContract(declared(adapter));
        expect(r.paths).toEqual({ ok: true, triggerRoot: 'EventPack.triggers', armedPath: 'EngineDerived.EventArmed' });
        expect(r.writes).toEqual({ ok: true, writes: adapter.writes });
        expect(r.rewards).toEqual({ ok: true, rewards: adapter.rewards });
        expect(r.scopes).toEqual({ ok: true, scopes: ['once', 'always'] });
        expect(r.format).toBe('1.2');
    });

    // MUTATION-VERIFIED: disabling the missing-path guard does NOT make this pass, because the two
    // refusals are asserted APART. Without that, the dotted-path check below catches a null anyway
    // (String(null) is "null", which has no dot) and returns its own refusal — so a test matching only
    // the field name goes green with the guard deleted, and the guard is not known to be a guard.
    it('MUTATION TARGET — a MISSING path is refused as MISSING, not mislabelled as malformed', () => {
        const r = readEventContract(declared({ ...adapter, armedPath: null }));
        expect(r.paths.ok).toBe(false);
        expect(r.paths.reason).toMatch(/declares no `armedPath`/);
        expect(r.paths.reason).not.toMatch(/not a dotted path/);
    });

    it('MUTATION TARGET — an EMPTY-STRING path is missing too, not a path that happens to be short', () => {
        const r = readEventContract(declared({ ...adapter, triggerRoot: '' }));
        expect(r.paths.reason).toMatch(/declares no `triggerRoot`/);
    });

    it('MUTATION TARGET — a path that is not DOTTED is refused, and the example names no genre', () => {
        const r = readEventContract(declared({ ...adapter, triggerRoot: 'EventPack' }));
        expect(r.paths.ok).toBe(false);
        expect(r.paths.reason).toMatch(/not a dotted path/);
        // L1: the shipped message must not teach one genre's schema to another genre's author.
        expect(r.paths.reason).not.toMatch(/Mainchar|Classmate|EngineDerived/);
    });

    it('writes is a WARNING lane — absent refuses the verdict, and the caller keeps installing', () => {
        expect(readEventContract(declared({ ...adapter, writes: null })).writes.ok).toBe(false);
        expect(readEventContract(declared({ ...adapter, writes: [{ ownerStamp: 'x' }] })).writes.ok).toBe(false);
        // …while paths stays fine, which is what lets the caller warn instead of refuse.
        expect(readEventContract(declared({ ...adapter, writes: null })).paths.ok).toBe(true);
    });

    it('rewards ABSENT is a real answer — an engine that pays nothing is a complete engine', () => {
        expect(readEventContract(declared({ ...adapter, rewards: null })).rewards).toEqual({ ok: true, rewards: [] });
    });

    it('…but a rewards kind that IS declared and is broken is refused, per broken field', () => {
        const bad = (kind) => readEventContract(declared({ ...adapter, rewards: [kind] })).rewards;
        expect(bad({ path: 'Mainchar', fields: ['Int'], max: 8 }).reason).toMatch(/has no `name`/);
        expect(bad({ name: 'stat', fields: ['Int'], max: 8 }).reason).toMatch(/no dotted `path`/);
        expect(bad({ name: 'stat', path: 'Mainchar', max: 8 }).reason).toMatch(/declares no `fields`/);
    });

    // SECURITY: `__proto__`, `constructor` and `prototype` are all \w, so the dotted-path shapes admit
    // them. A declared triggerRoot reaches ensurePath on the live stat_data, where `__proto__.x` would
    // create `x` on Object.prototype — so every declared path refuses them, naming the key.
    it('a PROTOTYPE KEY in any declared path is refused, by name', () => {
        const paths = readEventContract(declared({ ...adapter, triggerRoot: '__proto__.triggers' })).paths;
        expect(paths.ok).toBe(false);
        expect(paths.reason).toMatch(/"__proto__" is a prototype key/);
        expect(readEventContract(declared({ ...adapter, armedPath: 'EngineDerived.constructor' })).paths.reason).toMatch(/"constructor" is a prototype key/);
        expect(readEventContract(declared({ ...adapter, writes: [{ path: 'constructor.prototype' }] })).writes.reason).toMatch(/"constructor" is a prototype key/);
        expect(readEventContract(declared({ ...adapter, rewards: [{ name: 'stat', path: 'Mainchar.prototype', fields: ['Int'] }] })).rewards.reason).toMatch(/"prototype" is a prototype key/);
    });

    it('…but a key that only CONTAINS one of those words is an ordinary key', () => {
        const r = readEventContract(declared({ ...adapter, triggerRoot: 'Prototypes.__protocol__', writes: [{ path: 'Constructors' }] }));
        expect(r.paths.ok).toBe(true);
        expect(r.writes.ok).toBe(true);
    });

    // REGRESSION: a scalar `max` test here refused the WHOLE verdict, which switched off
    // unallowedRewardKinds and mismatchedRewardShapes — neither of which reads `max`. mvu-helper
    // validates only the three fields it consumes; ceilings are the engine's, in whatever shape it
    // keeps them, and it applies them itself at fire time.
    it('a CEILING in any shape is accepted — mvu-helper reads none of them', () => {
        const ok = (max) => readEventContract(declared({
            ...adapter, rewards: [{ name: 'money', path: 'Mainchar', fields: ['Money', 'Salary'], max }],
        })).rewards.ok;
        expect(ok(10), 'scalar').toBe(true);
        expect(ok({ Money: 50000, Salary: 10000 }), 'per-field map (School v4)').toBe(true);
        expect(ok(undefined), 'no ceiling declared at all').toBe(true);
    });

    it('scopes must be plain identifiers — the engine declares the vocabulary, this only checks its SHAPE', () => {
        expect(readEventContract(declared({ ...adapter, scopes: null })).scopes.ok).toBe(false);
        expect(readEventContract(declared({ ...adapter, scopes: ['once', 'not a word'] })).scopes.ok).toBe(false);
        expect(readEventContract(declared({ ...adapter, scopes: [] })).scopes).toEqual({ ok: true, scopes: [] });
    });

    it('bodyEntry ABSENT is a real answer — the entry keeps the host\'s default slot', () => {
        expect(readEventContract(declared(adapter)).bodyEntry).toEqual({ ok: true, entry: null });
        expect(readEventContract(declared({ ...adapter, bodyEntry: null })).bodyEntry).toEqual({ ok: true, entry: null });
    });

    it('a declared bodyEntry is carried as the slot the installer writes', () => {
        expect(readEventContract(declared({ ...adapter, bodyEntry: { position: 'at_depth_as_system', depth: 0, order: 750 } })).bodyEntry)
            .toEqual({ ok: true, entry: { position: 'at_depth_as_system', depth: 0, order: 750 } });
        // A position that is not at depth carries no depth, whatever the card wrote there.
        expect(readEventContract(declared({ ...adapter, bodyEntry: { position: 'before_character_definition', depth: 3, order: 750 } })).bodyEntry.entry)
            .toEqual({ position: 'before_character_definition', depth: null, order: 750 });
    });

    it('MUTATION TARGET — a malformed bodyEntry is refused, naming the field at fault', () => {
        const bad = (bodyEntry) => readEventContract(declared({ ...adapter, bodyEntry })).bodyEntry;
        expect(bad('depth0').reason).toMatch(/declares `bodyEntry` as "depth0"/);
        expect(bad([]).ok).toBe(false);
        expect(bad({ position: 'at_end', order: 750 }).reason).toMatch(/`bodyEntry.position` as "at_end", which is not a worldbook position/);
        expect(bad({ position: 'at_depth_as_system', order: 750 }).reason).toMatch(/needs a whole number of messages from the end/);
        expect(bad({ position: 'at_depth_as_system', depth: -1, order: 750 }).ok).toBe(false);
        expect(bad({ position: 'at_depth_as_system', depth: 0, order: '750' }).reason).toMatch(/`bodyEntry.order` as "750"/);
        expect(bad({ position: 'at_depth_as_system', depth: 0, order: 7.5 }).ok).toBe(false);
        // …and a bad slot leaves every other verdict standing.
        expect(readEventContract(declared({ ...adapter, bodyEntry: 'depth0' })).paths.ok).toBe(true);
    });

    it('NO ENGINE refuses the slot too, with the same reason as every other verdict', () => {
        const r = readEventContract(null);
        expect(r.bodyEntry).toEqual(r.paths);
    });

    it('an undeclared format is EMPTY, never a guess — the caller fixes the default at "1.0" (§3.1a)', () => {
        expect(readEventContract(declared({ ...adapter, format: null })).format).toBe('');
        expect(readEventContract(declared({ ...adapter, format: 2 })).format).toBe('');
    });

    it('junk in, no throw', () => {
        for (const junk of [undefined, 0, '', [], { eventPack: 'nope' }]) {
            expect(() => readEventContract(junk)).not.toThrow();
        }
    });
});

// The fixture above is a FIXTURE, and a fixture is exactly what let the DataCloneError assumption
// through: it agreed with what the plan believed the adapter looked like. This runs the REAL School
// engine end to end — execute the assembled bundle, take the identity the worker would report, and
// feed that to the gate — so the contract is checked against the object globalLogic actually builds.
describe.skipIf(!haveV4)('readEventContract against the REAL School engine', () => {
    const api = executeEngineText(schoolv4EngineText(), {});
    const declared = declaredIdentity(api);

    it('the live engine satisfies EVERY verdict the gate asks of it', () => {
        const r = readEventContract(declared);
        for (const k of ['paths', 'writes', 'rewards', 'scopes', 'bodyEntry']) {
            expect(r[k].ok, k + ': ' + (r[k].reason || '')).toBe(true);
        }
        expect(r.format).toBeTruthy();
    });

    it('the slot it declares for pack entries is the live adapter\'s own', () => {
        const slot = api.EVENT_PACK_ADAPTER.bodyEntry;
        expect(slot, 'School declares where community pack entries go').toBeTruthy();
        expect(readEventContract(declared).bodyEntry.entry).toEqual({
            position: slot.position, depth: slot.position.startsWith('at_depth_') ? slot.depth : null, order: slot.order,
        });
    });

    // The real engine is what caught the `max` defect a fixture agreed with: School pays several
    // fields per kind, so its ceilings are per-field maps, and one kind declares none. Kept as a
    // live assertion so a future narrowing of the verdict fails HERE, against real data.
    it('its reward ceilings are per-field maps and sometimes absent — and it still passes', () => {
        const shapes = api.EVENT_PACK_ADAPTER.rewards.map((k) => typeof k.max);
        expect(shapes).toContain('object');
        expect(shapes).toContain('undefined');
        expect(readEventContract(declared).rewards.ok).toBe(true);
    });

    it('and the paths it reports ARE the live adapter\'s own, not a copy of them', () => {
        const r = readEventContract(declared);
        for (const field of EVENT_PACK_PATH_FIELDS) {
            expect(r.paths[field], field).toBe(api.EVENT_PACK_ADAPTER[field]);
        }
    });
});

// One getter for every hosted scope, the game's included: the side panel asks it for a GameLogic Pack's
// renderPanel, so a game scope that answered null would never compute its slot.
describe('engineScopeApi — which API answers a scope', () => {
    const gameApi = { renderPanel() {} };
    const pluginApi = { resolveRelay() {} };
    const scopeApis = { 'plugin:weather': pluginApi };

    it('MUTATION TARGET — the game scope answers with the game\'s own API', () => {
        expect(engineScopeApi({ gameApi, scopeApis }, GAME_ENGINE_SCOPE)).toBe(gameApi);
    });
    it('every other scope answers from the table', () => {
        expect(engineScopeApi({ gameApi, scopeApis }, 'plugin:weather')).toBe(pluginApi);
    });
    it('nothing answers: null, never another scope\'s API', () => {
        expect(engineScopeApi({ gameApi: null, scopeApis }, GAME_ENGINE_SCOPE)).toBeNull();
        expect(engineScopeApi({ gameApi, scopeApis }, 'plugin:none')).toBeNull();
        expect(engineScopeApi({ gameApi, scopeApis: null }, 'plugin:weather')).toBeNull();
        expect(engineScopeApi({}, '')).toBeNull();
    });
});
