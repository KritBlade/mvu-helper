// logic-engine/logic-engine-loader.js — run the card's uploaded engine in a WORKER and expose it as
// `globalThis.LogicEngine`. Load and expose only: the turn runner (turn-runner.js) resolves turns, so
// nothing here writes stat_data.
//
// This file is the ST side: profile gate, worldbook read, the SillyTavern snapshot handed to the engine
// per call (the message projection behind MvuHelper.messages, the settings behind MvuHelper.settings and
// the log gate behind MvuHelper.log), and the `LogicEngine` global. The engine text itself never becomes
// code on this thread — see below.
//
// SECURITY. The `[MVU_LogicEngine]` worldbook entry — like every engine text the Worker hosts — is
// attacker-controlled input: any user can edit it, and a shared card can arrive with one already baked
// in (readEmbeddedEngineCode loads it at CHAT_CHANGED with no upload and no dialog — so an upload-time
// warning would protect nothing). Four defences:
//   • THE WORKER (engine-worker-host.js). The text is evaluated in a DedicatedWorkerGlobalScope, which
//     has no `document`, no frames and no `window.parent` — closing the two realm escapes no main-realm
//     block can (`document` and `window[N]` are both unforgeable, so no allow-list of NAMES can reach
//     them). This thread holds no reference the engine can walk.
//   • THE CAPABILITY BLOCK (engine-capability-block.js), raised INSIDE that Worker and never lowered —
//     a Worker still ships `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `indexedDB`, `caches`.
//   • THE ENGINE FRAME (engine-frame-core.js). The Worker is started by a hidden frame whose
//     Content-Security-Policy it inherits — `default-src 'none'`, `script-src 'unsafe-eval'` and no URL —
//     so dynamic `import()`, the one network door no NAME can close, is refused for every URL.
//   • `getLogicEngineApi()` as the tamper-resistant handle (see below).
// Engine identity is what the engine DECLARES and the Worker reports at load (`declared`), read back
// through getScopeDeclared — never recovered from the engine's text. It is COMPATIBILITY machinery,
// never vetting: a hostile bundle can declare a perfectly valid constant. Do not let its presence read
// as a safety check.
//
// ⚠ EVERY ENGINE EXPORT IS ASYNC. The functions on `globalThis.LogicEngine` post a message and
// return a Promise, so both mvu-helper's call sites and the card's own [PRE]/narrate EJS must `await`
// them (ST-Prompt-Template compiles with `async: true`). A missed `await` does not throw — it renders
// "[object Promise]" into the prompt. There is deliberately no sync fallback: it would leave the realm
// escape open on that branch. The dice dealer is not an engine export: it is mvu-helper's own,
// synchronous, on globalThis.MvuHelper.rollPool.

import { profileKey } from '../../sillytavern/settings-store.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { GAME_ENGINE_SCOPE, engineScopeApi, groupEngineNotesByKind, statusAfterUnreadableBook } from './logic-engine-core.js';
import { snapshotSillyTavernForEngine, registerCapabilityBlockReporter } from './engine-capability-block.js';
import { startEngineWorker, terminateEngineWorker } from './engine-worker-host.js';

// The block itself imports nothing (so the Node suite can run the attack against it) — this is the
// registration that gives it a voice. It covers the MAIN-THREAD copy of the module; the Worker's own
// copy registers its own reporter, which forwards over postMessage (engine-worker-host.js).
registerCapabilityBlockReporter((message) => log.warn(message));
import { getLogicEngineProfile, readEngineCode, readEmbeddedEngineCode } from './logic-engine-store.js';

const log = createModuleLog('logic-engine');

// Load state for the ACTIVE card — one Worker at a time (switching cards reloads).
// status: 'disabled' | 'no-engine' | 'book-not-ready' | 'loaded' | 'error' — the GAME engine's state.
//   'no-engine' can coexist with a RUNNING Worker: the other scopes host even on a card that ships no
//   game engine (a plugin runs on any card, and a StatusMenu Engine keeps rendering the player's view
//   whether or not a game brain is loaded beneath it).
// source: '' | 'standalone' | 'embedded'  — WHERE the running game text came from. 'embedded' is
//   PROVISIONAL (the card's import-time snapshot, loaded because the standalone book had not
//   registered yet) and must be re-checked; callers use this to know a retry is still worthwhile
//   even though status already says 'loaded'.
// scopeApis: scope → async API proxies for every engine OTHER than the game's — plugin engines
//   and the StatusMenu Engine. Keyed by scope and ranked by nothing, on purpose: these
//   are not one category. A plugin is a third party bolted onto a game; the StatusMenu Engine is the
//   game's own display half, the Logic Engine's counterpart on the player's side. The map holds them
//   the same way only because a Worker scope is a Worker scope. The game's own API is `api`;
//   getEngineScopeApi answers for every scope, the game's included.
//   scopeTextsKey identifies that text set for the reload-skip check; workerHosted says a boot
//   SUCCEEDED (error states never set it, so the cache can trust it).
let state = { key: '', text: '', scopeTextsKey: '', status: 'disabled', scopeDeclared: {}, activePackId: null, exports: [], error: '', api: null, source: '', scopeApis: {}, workerHosted: false };

// THE ONE RUNTIME READER of what an engine declared about itself. Every consumer goes through here —
// engineInfo, getLogicEngineStatus, the load note, the StatusMenu tab, the plugin relay, the
// event-pack gate — so four features cannot drift into four slightly different ideas of the same fact.
// A second accessor of this cache is a defect however it behaves today.
//
// Per SCOPE, not per card: a standalone plugin runs on a bare card where the game half is absent, and
// it still declares its own version. Absent scope ⇒ null, meaning UNKNOWN.
export function getScopeDeclared(scope) {
    return (state.scopeDeclared && state.scopeDeclared[String(scope || '')]) || null;
}

export function getLogicEngineStatus() {
    const declared = getScopeDeclared(GAME_ENGINE_SCOPE);
    return { status: state.status, version: (declared && declared.version) || '', name: (declared && declared.name) || null, exports: state.exports.slice(), error: state.error, bytes: state.text.length, source: state.source };
}

// The narrow identity surface — the WHOLE contract for "which engine is this":
// { name, type, version, packId, exposes }, nulls (and {}) when unknown. name / type / version are the
// game engine's exported ENGINE_NAME / ENGINE_TYPE / ENGINE_VERSION; packId is the active GameLogic
// Pack's id, exposes its interface map. Deliberately NOT the raw globalThis.LogicEngine API: branching
// code needs a few facts, and handing it the live engine object would turn every engine internal into a
// public contract. Exposed as globalThis.MvuHelper.engineInfo (composition, src/index.js), read by the
// {{mvuhelperEngineName}}/{{mvuhelperEngineVersion}} macros, and rebuilt INSIDE the Worker under the same
// name, so a menu or plugin engine asks the one question in one way. SYNCHRONOUS by design — its
// consumers are renders that cannot await a lorebook read, which is why packId and exposes are read from
// caches registered below.
//
// A card with no game engine is a real card (a standalone plugin's): it answers all-null with
// `exposes: {}`, a usable answer rather than an absent one. A null field means the engine declares
// nothing there — UNKNOWN, which a menu or plugin treats as neither a match nor a refusal.
export function engineInfo() {
    // Through getScopeDeclared, like every other consumer. An absent game scope answers all-null, which
    // is what a bare card and an engine that declares nothing BOTH honestly mean — so a status guard
    // would be the same answer by a second route, and is not spelled here.
    const declared = getScopeDeclared(GAME_ENGINE_SCOPE);
    return {
        name: (declared && declared.name) || null,
        type: (declared && declared.type) || null,
        version: (declared && declared.version) || null,
        packId: state.activePackId || null,
        exposes: resolveActiveExposes(),
    };
}

// What the Worker is sent with every message so the facade in there can answer the same question.
// Sampled per call rather than captured once, for the reason hostSnapshot is: the engine reloads and
// packs are activated mid-session, and a captured copy would answer with the previous card's identity.
export function engineSnapshot() {
    return engineInfo();
}

// The identity WITHOUT the interface map — { name, type, version, packId } — handed to a plugin's hooks
// as ctx.engine (resolveRelay and renderPanel alike). A plugin's `exposes` reach it separately, resolved
// to what it declared.
export function engineIdentity() {
    const { name, type, version, packId } = engineInfo();
    return { name, type, version, packId };
}

// The loaded engine's API object (module.exports of the bundle), or null. The turn runner uses
// THIS — not globalThis.LogicEngine, which uploaded code could shadow/tamper with.
export function getLogicEngineApi() {
    return state.status === 'loaded' ? state.api : null;
}

// One hosted scope's API proxies — the game's (GAME_ENGINE_SCOPE), a plugin's `plugin:<id>`, the menu's
// `statusmenu`, each spelled by its own feature — or null: absent scope, failed eval and no-Worker all
// read the same way, because to a caller they are the same fact: nothing answers there.
export function getEngineScopeApi(scope) {
    return engineScopeApi({ gameApi: getLogicEngineApi(), scopeApis: state.scopeApis }, scope);
}

// MANY calls into one scope, ONE Worker round trip — the formatter pre-pass contract.
// Returns the per-call entries ({ ok, value } | { ok:false, missing } | { ok:false, error }), or
// null when no Worker is hosted — "cannot ask" and "asked and missing" are different facts and the
// caller renders them differently.
export async function callEngineScopeBatch(scope, calls) {
    if (!state.workerHosted || typeof state.batchCall !== 'function') return null;
    return state.batchCall(String(scope || ''), Array.isArray(calls) ? calls : []);
}

// The registered sources of the NON-GAME engine texts (P5 inversion — this feature imports no
// artifact feature; each registers itself at composition time in src/index.js). Two consumers made
// it a list (P3): gamelogic-plugin (one text per installed plugin) and statusmenu-pack (the
// StatusMenu Engine — the DISPLAY counterpart of the game's Logic Engine, not an add-on to it).
//
// Contract per source: async () => [{ scope, code, version, kind }] — [] when none. A throwing
// source skips ITS texts, never the load.
//
// `kind` is a display word the SOURCE owns and this file never interprets — it only groups the
// reload line by it and prints it verbatim. That is the whole point: the loader cannot rank these
// texts. One loader-chosen word mislabels some of them — "plugin" for everything non-game, or "also
// hosted", when a StatusMenu Engine is not something hosted BESIDE the game but the user-facing half
// OF it. A blind label the owner supplies cannot drift that way. Sources that declare no kind fall
// into a neutral bucket rather than borrowing another's word.
const engineTextSources = [];
export function registerEngineTextSource(fn) {
    if (typeof fn === 'function') engineTextSources.push(fn);
}
// The plugin lane's name for the same registration.
export function registerPluginEngineSource(fn) {
    registerEngineTextSource(fn);
}

// The registered source of the ACTIVE pack's id (engineInfo's packId). Same P5 inversion as
// the plugin-engine source above: which pack owns this card is the gamelogic-pack feature's fact,
// and this feature stays pack-blind. Resolved once per load, cached in `state` — a pack switch
// rewrites the engine entry and reloads, so the cache refreshes exactly when the answer can change.
// Contract: async () => string | null.
let activePackIdSource = null;
export function registerActivePackIdSource(fn) {
    if (typeof fn === 'function') activePackIdSource = fn;
}
async function resolveActivePackId() {
    if (!activePackIdSource) return null;
    try { return (await activePackIdSource()) || null; }
    catch (e) { log.warn('the active-pack-id source threw — engineInfo().packId stays null this load:', e); return null; }
}

function unload(status, error) {
    if (globalThis.LogicEngine) delete globalThis.LogicEngine;
    // The Worker outlives this module's state unless we say so — an orphaned one keeps the previous
    // card's engines alive, holding their memory and still answering any `call` handle that leaked.
    terminateEngineWorker();
    state = { key: '', text: '', scopeTextsKey: '', status, scopeDeclared: {}, activePackId: null, exports: [], error: error || '', api: null, source: '', scopeApis: {}, workerHosted: false };
}

// The ACTIVE pack's `exposes` map — the gamelogic-pack feature's fact, injected rather than
// imported (P5: a lower layer must never import a feature). Absent source ⇒ {}, which is exactly what
// a card with no pack exposes, so the caller needs no separate "unknown" branch.
let activeExposesSource = null;
export function registerActiveExposesSource(fn) {
    activeExposesSource = typeof fn === 'function' ? fn : null;
}
function resolveActiveExposes() {
    if (!activeExposesSource) return {};
    try {
        const map = activeExposesSource();
        return (map && typeof map === 'object') ? map : {};
    } catch (e) {
        log.warn('the active-exposes source threw — engineInfo().exposes stays empty:', e);
        return {};
    }
}

// The engine's view of the page (messages, settings, log gate), sampled fresh for EVERY call rather than
// captured once: the snapshot crosses by structured clone, so a stale one would silently feed the
// engine last turn's message list — and the latest reply's index is exactly what a stale read gets wrong.
function hostSnapshot() {
    try { return snapshotSillyTavernForEngine(typeof window !== 'undefined' ? window.SillyTavern : null); }
    catch (e) { log.warn('could not snapshot SillyTavern for the engine (sending an empty host):', e); return null; }
}

// SERIALISE THE LOADS. Loading is async and spawns a Worker, and startEngineWorker terminates the
// previous one — so two overlapping loads mean the second kills the first mid-boot and the first's
// `await` never settles, leaving status stuck. Overlap is not hypothetical here: CHAT_CHANGED, a
// generation start and the tab's own refresh can all call this within a tick of each other. A late
// caller simply chains behind whatever is running and re-checks the cache when it gets there.
let loadInFlight = null;

// (Re)load the active card's engine. Idempotent + cheap: same card + same text = no re-eval.
// `force` skips that cache (the tab's Reload button, and any fresh install/clear).
export function loadLogicEngine(options = {}) {
    const run = () => loadLogicEngineOnce(options);
    // `.then(run, run)` on BOTH settlements: a load that failed must not stall the queue behind it.
    const chained = loadInFlight ? loadInFlight.then(run, run) : run();
    loadInFlight = chained;
    // Cleared only while the tail is still OURS, so a later caller that already chained onto `chained`
    // is not stranded by us nulling the field out from under it.
    const clear = () => { if (loadInFlight === chained) loadInFlight = null; };
    chained.then(clear, clear);
    return chained;
}

async function loadLogicEngineOnce({ force = false } = {}) {
    const profile = getLogicEngineProfile();
    if (!profile.enabled) {
        if (state.status !== 'disabled') { unload('disabled'); log.lifecycle('disabled for this card — engine unloaded'); }
        return getLogicEngineStatus();
    }
    // AUTHORITATIVE source first: the standalone worldbook is what ST actually uses and where the
    // LogicEngine tab's Install writes.
    let read = await readEngineCode();
    let source = 'standalone';
    if (read === null) {
        // Standalone book not queryable yet — the CHAT_CHANGED gap. Fall back to the card's EMBEDDED
        // copy, which exists the moment the character is selected, so the [PRE] entries rendering RIGHT
        // NOW get a working engine instead of a UNAVAILABLE notice. Provisional: marked source
        // 'embedded' and re-checked below on any later call.
        const embedded = readEmbeddedEngineCode();
        if (embedded && embedded.found && embedded.text.trim()) {
            read = embedded;
            source = 'embedded';
        } else {
            // Nothing anywhere yet — keep whatever is RUNNING; a later CHAT_CHANGED / generation /
            // tab-open retries. A hosted Worker (game engine, or plugins on a 'no-engine' card)
            // outlives a momentarily unreadable book, so its status must not degrade: the relay
            // deciders key on 'no-engine' exactly, and the same-bytes reload cache below never
            // restores a status once it lies (the decision: statusAfterUnreadableBook).
            state.status = statusAfterUnreadableBook(state.status, state.workerHosted);
            return getLogicEngineStatus();
        }
    }
    const gameText = (read.found && read.text.trim()) ? read.text : '';
    if (!gameText) source = '';

    // The non-game engine texts — plugin engines and the StatusMenu Engine — from the registered
    // sources. Read even when the game ships no engine (each runs on any card, and the StatusMenu
    // keeps rendering with no game beside it), and a throwing source SKIPS its own texts rather than
    // the load.
    let scopeTexts = [];
    for (const source of engineTextSources) {
        try { scopeTexts = scopeTexts.concat((await source()) || []); }
        catch (e) { log.warn('an engine-text source threw — its texts are skipped this load:', e); }
    }

    if (!gameText && !scopeTexts.length) {
        unload('no-engine');
        return getLogicEngineStatus();
    }
    const key = profileKey();
    const scopeTextsKey = scopeTexts.map((t) => String(t.scope || '') + '\u0001' + String(t.code || '')).join('\u0000');
    if (!force && state.workerHosted && state.key === key && state.text === gameText && state.scopeTextsKey === scopeTextsKey) {
        // Same bytes, every scope. If we were running the provisional embedded copy and this read
        // proves the standalone book now says the same thing, PROMOTE the source without
        // re-evaluating — the engine is already correct, only our confidence in it changes.
        if (state.source === 'embedded' && source === 'standalone') state.source = 'standalone';
        return getLogicEngineStatus();   // already running exactly these engines
    }
    // THE HOT-SWAP. Reaching here from a provisional load means the standalone copy differs from the
    // card's baked one — i.e. an engine was installed through the tab after the card was imported. Say
    // so, because silently swapping the engine mid-session is exactly the kind of thing that makes a
    // later bug report impossible to read.
    const swapping = state.status === 'loaded' && state.source === 'embedded' && source === 'standalone';
    try {
        // The `[MVU_LogicEngine]` entry — and every plugin engine entry — is attacker-controlled
        // input: any user can edit them and a shared card can arrive with them baked in. They become
        // code in the WORKER and nowhere else; this thread only ever hands over strings. Swapping ANY
        // text restarts the Worker and reloads ALL.
        const texts = [];
        if (gameText) texts.push({ scope: GAME_ENGINE_SCOPE, code: gameText });
        for (const t of scopeTexts) texts.push({ scope: String(t.scope || ''), code: String(t.code || '') });
        const worker = await startEngineWorker(texts, { hostSnapshot, engineSnapshot });

        // The GAME scope's eval error is the LOUD path — nothing else resolves a turn, so it is
        // all-or-nothing. A PLUGIN scope's error is contained below instead: one broken plugin engine
        // must never take the game (or another plugin) down.
        const gameScope = gameText ? (worker.scopes[GAME_ENGINE_SCOPE] || { exports: [], error: 'the worker reported nothing for the game scope' }) : null;
        if (gameScope && gameScope.error) throw new Error(gameScope.error);

        const scopeApis = {};
        // Every scope's declared identity, collected in ONE place and written into state below on BOTH
        // branches — including 'no-engine'. A standalone plugin (one declaring no `requires`) runs on a
        // bare card through that branch, and it still owes its own version to the load line and the
        // tabs; populating this only where a game engine exists would leave every bare-card plugin
        // reporting nothing.
        const scopeDeclared = {};
        if (gameScope && gameScope.declared) scopeDeclared[GAME_ENGINE_SCOPE] = gameScope.declared;
        // Collected flat, grouped by the pure helper below, so the reload line reports each KIND of
        // engine under the word its own feature chose ("display engine: …", "plugins: …") instead of
        // flattening them into one list that necessarily mislabels all but the first.
        const scopeNotes = [];
        const note = (kind, text) => scopeNotes.push({ kind, note: text });
        for (const t of scopeTexts) {
            const scope = String(t.scope || '');
            const s = worker.scopes[scope] || { exports: [], error: 'the worker reported nothing for this scope' };
            if (s.error) {
                // Names the SCOPE and states only what is certainly true of any of them. A plugin-only
                // consequence ("its relay resolver will NOT run") would, over the StatusMenu scope (no
                // relay at all), name a mechanism the reader would then go looking for. The scope
                // prefix already says which feature owns it.
                log.error(`engine scope "${scope}" failed to load — nothing it exports is callable this session: ${s.error}`);
                note(t.kind, `${scope} ERROR`);
                continue;
            }
            const api = {};
            // Namespaced names ('formatters.moneyDisplay') proxy beside the flat ones — the StatusMenu
            // Engine's whole call surface is nested, and a plugin gains the same reach for free.
            for (const name of [...s.exports, ...(s.nestedExports || [])]) api[name] = (...args) => worker.call(scope, name, args);
            scopeApis[scope] = api;
            if (s.declared) scopeDeclared[scope] = s.declared;
            const shown = [...s.exports, ...(s.nestedExports || [])];
            // The version this scope DECLARED, not one parsed out of its text before it ran.
            note(t.kind, `${scope} ${(s.declared && s.declared.version) || '(no version)'} [${shown.join(', ') || 'no exports'}]`);
        }

        const prevVersion = (getScopeDeclared(GAME_ENGINE_SCOPE) || {}).version || '';
        const prevBytes = state.text.length;
        if (gameText) {
            // Identity comes from what the engine DECLARED and the worker reported — never parsed back
            // out of its text. A null here means the engine declares nothing, which is UNKNOWN, and is
            // reported as such rather than guessed at.
            const version = (gameScope.declared && gameScope.declared.version) || '';
            if (!version) log.warn('this engine declares no ENGINE_VERSION — it will report an unknown version. Declare `const ENGINE_VERSION = \'v<major>.<minor>\'` and export it.');
            const activePackId = await resolveActivePackId();      // cached for the sync engineInfo()
            const names = (gameScope.exports || []).slice();
            // One async proxy per exported name. The Worker reports which of its exports are
            // FUNCTIONS, so a non-function export (EVENT_PACK_ADAPTER, which the drift guard reads in the
            // Node suite) is deliberately not proxied — its value lives behind the clone boundary and
            // a proxy would only promise a shape we cannot deliver synchronously.
            const api = {};
            for (const name of names) api[name] = (...args) => worker.call(GAME_ENGINE_SCOPE, name, args);
            // The dice dealer is NOT here: it is the platform's, on globalThis.MvuHelper.rollPool, present
            // on every card whether or not a game engine is hosted.
            globalThis.LogicEngine = { ...api, _version: version };
            state = { key, text: gameText, scopeTextsKey, status: 'loaded', scopeDeclared, activePackId, exports: names, error: '', api, source, scopeApis, batchCall: (scope, calls) => worker.callBatch(scope, calls), workerHosted: true };
        } else {
            // Plugin engines only. The game half is honestly 'no-engine' — globalThis.LogicEngine
            // stays absent exactly as on any engine-less card — but the Worker runs for the plugins.
            // scopeDeclared is carried ANYWAY: the standalone lane lives here, and those plugins still
            // declare their own versions even with no game beside them.
            if (globalThis.LogicEngine) delete globalThis.LogicEngine;
            state = { key, text: '', scopeTextsKey, status: 'no-engine', scopeDeclared, activePackId: null, exports: [], error: '', api: null, source: '', scopeApis, batchCall: (scope, calls) => worker.callBatch(scope, calls), workerHosted: true };
        }
        // Read once, through the ONE reader, for every line below.
        const declaredNow = getScopeDeclared(GAME_ENGINE_SCOPE) || {};
        if (swapping) {
            log.lifecycle(`HOT-SWAP — the standalone worldbook carries a different engine than the card's `
                + `embedded copy; replaced ${prevVersion || '(no version)'} (${prevBytes} bytes) with `
                + `${declaredNow.version || '(no version)'} (${gameText.length} bytes). The tab-installed engine wins.`);
        }
        // The load line ENUMERATES what happened at load, so it names the isolation too — a security
        // control nobody can see in the log reads as absent, and "did the block actually run for this
        // engine?" is the first question a support thread will ask. Both numbers matter and neither
        // substitutes for the other: `replaced` is the Worker's OWN globals (the constructors), and
        // `neutralized` is the inherited ones (`fetch`, `indexedDB`, `caches`, `importScripts` …) replaced
        // in place on their prototype. A `neutralized: 0` here means the prototype walk found nothing and
        // the walked `fetch` is OPEN, so it is printed every load rather than summarised as a single "ON".
        // And it enumerates EVERY hosted text (the log-sanity rule: a line listing two of five texts
        // lies), so a failed plugin shows ERROR.
        const blockReport = worker.report || {};
        const reachedFor = Object.keys(blockReport.attempts || {});
        log.lifecycle(`loaded ${gameText ? `${declaredNow.version || '(declares no ENGINE_VERSION)'} — ${gameText.length} bytes, `
            // Identity in the SAME enumeration (log-sanity). Both labels name the DECLARATION, not a
            // header: an engine that declares neither is reporting UNKNOWN, which plugins treat as
            // "fall back to prose" rather than as a fault.
            + `name: ${declaredNow.name || '(declares no ENGINE_NAME)'}, pack: ${state.activePackId || '(none)'}, `
            + `source: ${source}${source === 'embedded' ? ' (PROVISIONAL — card snapshot, will re-check the standalone book)' : ''}, `
            + `exports: ${state.exports.join(', ') || '(none)'}` : 'NO game engine'}`
            // One clause PER KIND, each under the word its own feature supplied — so the StatusMenu
            // Engine reports as the game's display half rather than as something adjacent to it.
            + `${[...groupEngineNotesByKind(scopeNotes)].map(([kind, notes]) => `, ${kind}: ${notes.join(' · ')}`).join('')}, `
            + `isolation: WORKER (no document/frames), capability block: ${blockReport.replaced || 0} own + `
            + `${blockReport.neutralized || 0} inherited globals blocked, allows ${(blockReport.allowed || []).length} names, `
            + `reached for: ${reachedFor.join(', ') || 'nothing'}`);
    } catch (e) {
        log.error('engine failed to load — globalThis.LogicEngine cleared:', e);
        unload('error', String(e && e.message || e));
    }
    return getLogicEngineStatus();
}
