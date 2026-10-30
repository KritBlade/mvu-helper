// features/mvu-bootstrap — mvu-helper installs MVU itself.
//
// WHY THIS IS OURS AND NOT A PACK'S. MVU (MagVarUpdate) arrives as a TavernHelper SCRIPT that imports its
// bundle; its PRESENCE is the only reason a card is an MVU card at all. Every feature in this extension is
// built on it — Mvu.parseMessage, VARIABLE_UPDATE_ENDED, the turn runner, every pack's state lane — so an
// mvu-helper install without MVU is a broken install, independently of any pack. Making each pack carry the
// bootstrap would mean N copies of one platform dependency, and would leave a plugin-only or bare card with
// no `stat_data` at all.
//
// GLOBAL scope, once, rather than per card: `updateScriptTreesWith(updater, {type:'global'})` covers every
// card the user will ever open (scope names: see tavern-script.js).
//
// THREE COSTS, ALL PAID DELIBERATELY:
//   1. Consent — this writes to the user's SillyTavern, not to a card. It is offered once in a popup; a
//      decline is remembered rather than re-asked, and the Main tab's "Install MVU" button installs it later.
//   2. Duplicates — a card carrying its own MVU import runs a second MVU instance beside the global one
//      (duplicateCardMvuImports says why that freezes state). The card's copy is DISABLED, never deleted, and
//      the global is restarted. A card exported afterwards ships with its import off, and someone running it
//      without mvu-helper must turn it back on.
//   3. Reach — the global import loads MVU on non-game cards too, where it is inert (no init data, nothing to
//      do). The one state where it is NOT inert is no card at all, which the deferred loader below handles.

import { createModuleLog } from '../../sillytavern/log.js';
import { getGlobal, saveSettingsDebounced } from '../../sillytavern/settings-store.js';
import { confirmPopup } from '../../sillytavern/popup.js';
import {
    SCRIPT_SCOPE_GLOBAL,
    SCRIPT_SCOPE_CHARACTER,
    getScriptTrees,
    upsertScript,
    setScriptsEnabled,
    bounceScript,
    isScriptApiAvailable,
} from '../../sillytavern/tavern-script.js';
import { toast } from '../../sillytavern/mvu-bridge.js';
import { decideBootstrapAction, findMvuBundleImports, enabledMvuImports, duplicateCardMvuImports, waitUntilReady } from './mvu-bootstrap-core.js';
import { paintMvuStatusFor, wireInstallOfferButton } from './mvu-bootstrap-ui.js';

const log = createModuleLog('mvu-bootstrap');

// The script NAME MVU cards already ship, so a user reading their TavernHelper script list sees one familiar
// entry rather than a second mystery one.
const MVU_SCRIPT_NAME = 'mvu';

// THE bundle url — the mirror MVU cards use, PINNED to one MVU release tag. This script runs on the page for
// every card, so the code it loads is the release named here and nothing pushed to MVU's repository after
// it. Moving to a newer MVU is a deliberate edit of this line, after that release is tested.
const MVU_BUNDLE_URL = 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@v0.196.0/artifact/bundle.js';

// THE SCRIPT WE WRITE. Deferred, not eager — and the deferral is a correctness fix, not a cosmetic one.
//
// MVU initializes variables FROM the greeting message, and a greeting cannot exist until a chat is open. A
// GLOBAL TavernHelper script evaluates at TavernHelper startup, before any character is selected, so an eager
// `import` asks MVU for something impossible, and MVU answers correctly and loudly on every page load:
//     [MVU] Variable initialization failed — A greeting message is required to initialize variables
// Waiting for a chat is asking the question once it has an answer, not hiding the message.
//
// TWO ENTRY POINTS, because both happen:
//   • a chat is ALREADY open — an install writes this script mid-session and TavernHelper evaluates it at
//     once; without this branch MVU would not load until the next chat switch;
//   • otherwise the first CHAT_CHANGED — the page-load case.
// Neither waits for messages: a chat is open, which is where MVU belongs. Waiting for messages would leave a
// greeting-less chat with NO MVU when the user types the first line — absent MVU is far worse than one honest
// toast in a rare state.
const MVU_SCRIPT_CONTENT = `// MVU (MagVarUpdate) — installed and owned by MVU Helper. Loading waits until a chat is open:
// MVU initializes variables from the greeting message, and no greeting exists before a chat is
// opened, so importing at TavernHelper startup would ask MVU for something impossible (it answers
// "A greeting message is required to initialize variables").
const BUNDLE = '${MVU_BUNDLE_URL}';
let started = false;
const startMvu = () => { if (started) return; started = true; import(BUNDLE); };
// globalThis-prefixed + optional chaining so this can never throw before SillyTavern is ready.
const chatIsOpen = () => Boolean(globalThis.SillyTavern?.getContext?.()?.chatId);
if (chatIsOpen()) {
    startMvu();
} else if (typeof eventOn === 'function' && typeof tavern_events !== 'undefined') {
    eventOn(tavern_events.CHAT_CHANGED, startMvu);
} else {
    // The event API is how this script is meant to work; without it, load eagerly rather than never.
    // MVU present with a startup toast beats MVU absent, which would break every state feature.
    console.warn('[mvu-helper] [mvu-bootstrap] TavernHelper eventOn/tavern_events unavailable — loading MVU eagerly; expect an "initialization failed" toast at startup.');
    startMvu();
}
`;

// Global settings record: { declined }. Global, not per-profile — the script it guards is global too, so a
// per-card answer would ask again on every new card about a thing that is not per card.
function bootstrapRecord() {
    const g = getGlobal();
    g.mvuBootstrap = g.mvuBootstrap || { declined: false };
    return g.mvuBootstrap;
}

// TavernHelper attaches its script API well after mvu-helper initialises (measured ~14 s after document start),
// and attaches with or without a chat open. The load-time check waits for it, at most this long.
const SCRIPT_API_DEADLINE_MS = 30000;
const SCRIPT_API_POLL_MS = 500;

// One attempt at a time. This runs at extension load AND on every chat load (the retry that makes the
// 'unavailable' path self-heal), and ST emits CHAT_CHANGED more than once during a page refresh — so without
// this, two overlapping calls could stack two consent popups for one question.
let inFlight = null;

// Ensure MVU is installed globally. Called once the API attaches after extension load
// (ensureGlobalMvuImportAtLoad) and on every chat load, where it asks first; and
// by the Main tab's "Install MVU" button with `{ isRequestedByUser: true }`, where the click is the consent.
// Every result also repaints the Main tab's MVU status: its notice and pill (paintMvuStatusFor).
//
// Returns one of: 'present' (an enabled MVU import already exists globally — ours or the user's own, either
// is fine) · 'installed' · 'declined' · 'unavailable' (script API not attached yet) · 'failed'. Never throws.
export async function ensureGlobalMvuImport({ isRequestedByUser = false } = {}) {
    if (inFlight) return inFlight;
    inFlight = runGlobalMvuImport({ isRequestedByUser })
        .then((result) => { paintMvuStatusFor(result); return result; })
        .finally(() => { inFlight = null; });
    return inFlight;
}

// The load-time check: wait for TavernHelper's script API (SCRIPT_API_DEADLINE_MS at most), then ensure MVU.
// An API that never attaches means TavernHelper, which mvu-helper requires, is missing or broken — an error
// the user is shown, not a lifecycle line. A later chat load still retries.
export async function ensureGlobalMvuImportAtLoad() {
    const isAttached = await waitUntilReady(isScriptApiAvailable, {
        deadlineMs: SCRIPT_API_DEADLINE_MS,
        intervalMs: SCRIPT_API_POLL_MS,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    if (!isAttached) {
        const seconds = SCRIPT_API_DEADLINE_MS / 1000;
        log.error(`TavernHelper's script API did not attach within ${seconds} s, so MVU Helper cannot check whether`
            + ' MVU is installed. MVU Helper needs TavernHelper — check that it is installed and enabled. Retrying on chat load.');
        toast('error', `TavernHelper did not answer within ${seconds} s, so MVU Helper cannot check whether MVU is `
            + 'installed. MVU Helper needs TavernHelper — check that it is installed and enabled.');
        return 'unavailable';
    }
    return ensureGlobalMvuImport();
}

async function runGlobalMvuImport({ isRequestedByUser }) {
    const record = bootstrapRecord();

    // Read the API's availability BEFORE its answer: an empty answer from a detached API is
    // indistinguishable from a genuinely empty scope, and the two demand opposite actions.
    const apiAvailable = isScriptApiAvailable();
    const existing = apiAvailable
        ? enabledMvuImports(findMvuBundleImports(await getScriptTrees(SCRIPT_SCOPE_GLOBAL)))
        : [];

    const action = decideBootstrapAction({
        isScriptApiAvailable: apiAvailable,
        enabledImports: existing,
        hasDeclined: record.declined,
        isRequestedByUser,
    });

    if (action === 'unavailable') {
        // NOT an error, and nothing is recorded: a chat-load check can run before TavernHelper attaches. The
        // load-time check (ensureGlobalMvuImportAtLoad) waits for the API, and the next chat load retries.
        log.lifecycle('the TavernHelper script API is not attached yet — cannot tell whether MVU is'
            + ' installed, so nothing was asked or written. Retrying on chat load.');
        return 'unavailable';
    }

    if (action === 'present') {
        // A global import on a url other than ours is the user's own choice and works fine — only CARD-scoped
        // imports duplicate it.
        log.lifecycle(`MVU is already installed globally (${existing.map((e) => e.name).join(', ')}) — nothing to do`);
        return 'present';
    }

    if (action === 'declined') {
        log.warn('MVU is NOT installed and the user previously declined the global install.'
            + ' Every state feature (packs, plugins, the turn runner) is inert until MVU is present —'
            + ' install it with the "Install MVU" button in MVU Helper\'s Main tab.');
        return 'declined';
    }

    if (action === 'ask') {
        // Tone: a STATEMENT of what is about to happen, not a warning. MVU is this extension's named
        // dependency, and phrasing an obvious dependency defensively reads like an antivirus prompt. The
        // reasoning belongs in the installation instructions (README, github.com/KritBlade/mvu-helper), not in
        // a modal the user sees once.
        const accepted = await confirmPopup([
            { text: 'Install MVU now?' },
            { text: 'MVU Helper needs the MVU script. It is installed as a global TavernHelper script:', name: MVU_SCRIPT_NAME },
            { text: 'The installation instructions describe the same step.' },
        ], { okButton: 'Install' });
        if (!accepted) {
            record.declined = true;
            saveSettingsDebounced();
            log.warn('the MVU script was not installed — state features stay inert until it is.'
                + ' Install it with the "Install MVU" button in MVU Helper\'s Main tab.');
            return 'declined';
        }
    }

    const wrote = await upsertScript(SCRIPT_SCOPE_GLOBAL, MVU_SCRIPT_NAME, {
        content: MVU_SCRIPT_CONTENT,
        enabled: true,
        info: 'Installed by MVU Helper — MVU (MagVarUpdate) provides stat_data. See the MVU Helper installation'
            + ' instructions: https://github.com/KritBlade/mvu-helper',
    });
    record.declined = false;
    saveSettingsDebounced();
    if (!wrote) {
        log.error('the global MVU script could NOT be written — state features will not work (see the error above)');
        return 'failed';
    }
    // Written is not running: TavernHelper skips a script inside a disabled folder whatever its own flag says.
    const running = enabledMvuImports(findMvuBundleImports(await getScriptTrees(SCRIPT_SCOPE_GLOBAL)));
    if (!running.length) {
        log.error(`the global MVU script "${MVU_SCRIPT_NAME}" was written but TavernHelper does not run it — it sits`
            + ' in a disabled folder. Turn that folder on in TavernHelper\'s script list.');
        return 'failed';
    }
    log.lifecycle(`installed the global MVU script "${MVU_SCRIPT_NAME}" → ${MVU_BUNDLE_URL}`);
    // The global starts at once when a chat is open; a card import already running beside it is a second MVU
    // instance from this moment, so neutralize it now rather than on the next chat load.
    await neutralizeCardMvuDuplicates();
    return 'installed';
}

// Wire the Main tab's "Install MVU" button. The click is the consent, so it installs without a popup.
export function wireMvuInstallOffer() {
    wireInstallOfferButton(() => ensureGlobalMvuImport({ isRequestedByUser: true }));
}

// Per-card duplicate NEUTRALIZER (cost 2). Cheap — two script reads — and silent unless it finds a duplicate,
// so it rides CHAT_CHANGED, and it runs right after an install. mvu-helper installs the global by default, so a
// card-scoped copy in this environment is always the redundant one: disable it, then BOUNCE the global so an
// instance whose listeners the collision may already have stripped comes back fresh.
//
// The bounce runs ONLY when a duplicate was actually disabled: bouncing on every chat switch would restart a
// healthy MVU each time, and a restart mid-generation is exactly the disturbance this exists to prevent.
// Returns the [{ id, name, url, isEnabled }] imports it disabled ([] = none, or nothing could be done).
export async function neutralizeCardMvuDuplicates() {
    if (!isScriptApiAvailable()) return [];
    // A duplicate needs an ORIGINAL. Without an ENABLED global import — the user declined, or the consent popup
    // is still open on this very CHAT_CHANGED — the card's own import is the only MVU there is, and disabling
    // it would remove MVU entirely.
    const globalLive = enabledMvuImports(findMvuBundleImports(await getScriptTrees(SCRIPT_SCOPE_GLOBAL)));
    if (!globalLive.length) return [];
    const duplicates = duplicateCardMvuImports(findMvuBundleImports(await getScriptTrees(SCRIPT_SCOPE_CHARACTER)));
    if (!duplicates.length) return [];

    const changed = await setScriptsEnabled(SCRIPT_SCOPE_CHARACTER, duplicates.map((d) => d.id), false);
    if (changed === null) {
        log.error('the card\'s duplicate MVU import(s) could NOT be disabled — the double-load stands: '
            + duplicates.map((d) => '"' + d.name + '"').join(', '));
        return [];
    }
    if (!changed.length) return [];
    log.warn('this card carried its OWN MVU import beside mvu-helper\'s global one — a second MVU instance'
        + ' whose collision kills the message-parse listener for EVERY chat (state silently stops updating until'
        + ' a page reload). DISABLED the card\'s cop' + (duplicates.length === 1 ? 'y' : 'ies') + ': '
        + duplicates.map((d) => '"' + d.name + '" → "' + (d.url || '(unparsed url)') + '"').join(', ')
        + '. Ours stays: "' + MVU_BUNDLE_URL + '". The write persists into the card — re-enable the script in'
        + ' TavernHelper\'s editor if this card must run WITHOUT mvu-helper.');

    const bounced = await bounceScript(SCRIPT_SCOPE_GLOBAL, MVU_SCRIPT_NAME);
    toast('warning', 'This card carried its own MVU script beside the global one — a duplicate that silently '
        + 'freezes state updates. Disabled the card\'s copy'
        + (bounced ? ' and restarted the global MVU; play on normally.' : '; the global MVU could not be restarted — reload the page.'));
    return duplicates;
}

// Is MVU running at all, in EITHER scope? The honest answer to "why is nothing working". Counts only imports
// TavernHelper RUNS (script and folder enabled); `disabledFound` tells "no MVU anywhere" apart from "MVU is
// right there, switched off" — different problems, different fixes.
export async function isMvuPresent() {
    const [globalTrees, cardTrees] = await Promise.all([
        getScriptTrees(SCRIPT_SCOPE_GLOBAL),
        getScriptTrees(SCRIPT_SCOPE_CHARACTER),
    ]);
    const all = [...findMvuBundleImports(globalTrees), ...findMvuBundleImports(cardTrees)];
    const live = enabledMvuImports(all);
    return { present: live.length > 0, disabledFound: all.length > live.length };
}
