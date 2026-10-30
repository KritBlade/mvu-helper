// statusmenu-pack/statusmenu-frame.js — the HOST half of the contained menu frame
// (plans/executed/statusmenu-containment.md M3, M5, M7, M8): mounts the sandboxed frame into every marker-form
// region the lift left on the card, answers the messages a frame it mounted sends (height, overlay and
// error from the menu; blocked and reloaded from the wrapper around it), pushes stat_data to the menu in
// every frame it mounted, names the rows the gate cannot reach, and publishes the frame source so galgame-companion
// mounts the SAME document in a frame of its own (D7/D11).
//
// WHAT MOUNTS WHERE. The lift (M2) writes every fenced row to the card as its own region container
// with no fence, `data-mvu-helper-menu="<packId>"` and `data-mvu-helper-menu-row="<script_name>"`;
// TavernHelper renders nothing because there is no <pre>. On the page's OWN render events — not
// TavernHelper's `message_iframe_render_ended`, which fires from a TH frame's load and there is no
// TH frame any more — this file finds every such container not yet mounted and appends
// `<iframe sandbox="allow-scripts allow-modals">` whose srcdoc is the wrapper holding that ROW's
// document in a menu frame of its own (statusmenu-frame-core.js, "the wrapper", says why).
// ONE frame per container; a rebuilt container mounts again, a mounted one never twice.
//
// POLICY: EVERY message that carries a marker form gets its own frame, and each one shows ITS OWN
// message's state — a menu on an older reply is that reply's stats, which is the reason to keep it.
// State is per-message already (readMvuData takes the mid), so a historical frame needs no special
// path; it is the same mount with an older snapshot.
//
// ONLY THE NEWEST CAN WRITE. The dispatcher resolves every action against the latest AI message, so
// a button on an older menu would read the state it displays and act on a different turn. The
// dispatcher refuses those by the asking frame's mid rather than this file suppressing the mount —
// a refusal the user can see beats a menu that silently is not there.
//
// WHAT BOUNDS THE COUNT is the card's own regex chain, not a limit here. A row that blanks distant
// messages removes the placeholder before the menu's row can build a container from it, so no frame
// mounts for them. A card without such a row mounts one frame per reply, which is that card's
// choice to make; naming a number here would override it blind. No region name is spelled (L1).
//
// STATE. The srcdoc carries no stat_data: a mount reads none, and the menu starts with an empty state
// that its runtime draws from on the first push. So a frame that never loads — a reply far offscreen,
// which `loading="lazy"` keeps unloaded — costs no stat_data read and no copy of it in the page; with
// every reply on screen mounting a frame, a baked copy was the message's whole stat_data per frame,
// escaped once more by the wrapper (about 1.4 MB each on School, measured in Safari). The host pushes the
// current stat_data, to the menu's window inside the wrapper and not through its relay (pushTo says why),
// and only to a frame whose menu window exists: when the menu says it is READY — its prelude has run,
// which is every time the menu's document starts, a moved frame's and a reloaded menu's included; it is
// the menu's first state, and it lands while the document still loads, where the frame's `load` waits for
// every image the menu shows; when TavernHelper announces Mvu (MENU_MVU_READY_EVENT — a chat opens before
// its card's MVU script runs, so the first ready push can have nothing to send); on every MVU
// VARIABLE_UPDATE_ENDED; on the runner's RES-staged
// signal (RES1 has resolved, before its save); on MVU_STATE_SAVED_EVENT (every save through the bridge's
// save door — the runner's RES1 and RES2, the PRE apply, a menu action, a sync pass — since
// Mvu.replaceMvuData emits nothing); from the dispatcher after a menu action (awaited, for the acting
// menu); and for an edit NO event announces — TavernHelper's variable editor,
// Mvu.setMvuVariable, a script — from a check every MENU_STATE_CHECK_MS that pushes only a frame whose
// message's variables object was replaced since its last push. Every push records the object it read,
// so an idle chat pushes nothing and a reply the events already drew is not redrawn.
// The check runs only while this host has a frame mounted. Genre-blind: it compares an object, never
// a value.
// A push to a menu whose message the turn's write is about to re-render (reply-redraw's due write: the
// post-reply phase has reached its end) waits for that write, which takes the menu away with the old
// render: dropped when the menu has left the page, sent when it is still there. READY's push never waits.
//
// WHAT A DEAD MENU SAYS. A document that reads window.parent outside any try — every export made
// before MvuStatMenuBuilder 2.5.2 (containment §5) — throws at load; the prelude posts the error and
// this file warns naming the menu, the message and the fix. There is NO fallback to TavernHelper on
// that path: a fallback on load error is a bypass anyone can trigger with one unguarded parent read.

import { eventSource, event_types, substituteParams } from '../../../../../../../script.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { chatContext } from '../../sillytavern/chat-context.js';
import { getMvu } from '../../sillytavern/mvu-bridge.js';
import { MVU_VARIABLE_UPDATE_ENDED, MVU_STATE_SAVED_EVENT } from '../../sillytavern/mvu-bridge-core.js';
import { getGlobal } from '../../sillytavern/settings-store.js';
import { checkFrameVisibility } from '../../sillytavern/render-visibility.js';
import { restoreEnclosedRegions } from '../../sillytavern/rendered-region-placement.js';
import { REGEX_SCOPE_CHARACTER, isRegexApiAvailable, getRegexes } from '../../sillytavern/tavern-regex.js';
import { getStandaloneLorebookEntries } from '../../sillytavern/lorebook.js';
import { regionSelector, unwrapRenderedRegion } from '../../shared/rendered-region.js';
import { PLACEHOLDER_SHELL_REGEX } from '../../shared/placeholder-menu-shell.js';
import { RES_STAGED_EVENT } from '../logic-engine/index.js';
import { isReplyWriteDue, dueReplyWriteEnded } from '../reply-redraw/index.js';
import { MENU_MOUNT_ATTRIBUTE, MENU_MOUNT_ROW_ATTRIBUTE, auditMenuRows, menuBodyComment } from './statusmenu-pack-core.js';
import { readMenuBodies, readEmbeddedMenuBodies } from './statusmenu-body-store.js';
import { readMenuRegistryFrom } from './statusmenu-pack-activation.js';
import {
    MENU_FRAME_SANDBOX, MENU_FRAME_STYLE, MENU_FRAME_LIFTED_STYLE,
    MENU_IMAGE_SOURCES_SETTING, MENU_FRAME_IMAGE_SOURCES_DEFAULT,
    buildMenuFrameCsp, menuFramePrelude, composeMenuFrameSrcdoc, composeMenuFrameWrapperSrcdoc, readMenuFrameMessage, menuFrameErrorVerdict, menuFrameLiftStep, MENU_STATE_MESSAGE,
    isMenuFrameSandbox, menuFrameWindowRole, menuWindowOf,
    MENU_MVU_READY_EVENT, MENU_STATE_CHECK_MS, menuStateSlot, menuStatesToPush, shouldMenuPushWait,
} from './statusmenu-frame-core.js';

const log = createModuleLog('statusmenu-pack');

const MOUNTED_ATTRIBUTE = 'data-mvu-helper-menu-mounted';        // stamped on a container that has its frame
const FRAME_LABEL = 'mvu-helper:statusmenu';

// The row a second host means by "the menu" when it names none: the builder's shell row, whose name
// is the published cross-repo contract (shared/placeholder-menu-shell.js).
const DEFAULT_ROW_NAME = PLACEHOLDER_SHELL_REGEX.script_name;

// Every frame this host mounted, keyed by the frame ELEMENT. Not by its window: moving an iframe in the
// DOM reloads it with a NEW window, and two things move ours — region placement restoring an adopted
// region, and galgame's VIEW panel, which reparents a message's nodes into its own viewer. A message
// from a frame is matched by asking each element for its CURRENT windows: its own, or the menu's inside
// the wrapper (menuFrameWindowRole). Entries whose frame left the DOM are dropped on the next push.
const frames = new Map();

function entryForSource(source) {
    if (!source) return null;
    for (const entry of frames.values()) {
        if (menuFrameWindowRole(source, entry.frame.contentWindow)) return entry;
    }
    return null;
}

// The object the message's current swipe keeps its variables in — what an edit replaces.
function currentStateSlot(mid) {
    const ctx = chatContext('statusmenu-frame');
    const chat = ctx && ctx.chat;
    return menuStateSlot(Array.isArray(chat) ? chat[mid] : null);
}

// One frame's state push, posted to the menu's window inside the wrapper (menuWindowOf) rather than to the
// frame's own: the wrapper's relay would decode and encode the whole stat_data once more on the way. The
// stat_data is read at send time, and only for a frame whose menu window exists: before the wrapper has
// made the menu's frame — a lazy frame offscreen — there is nothing to post to and nothing is read, and
// nothing is lost: the menu asks for its state once its prelude runs (READY), and by then the wrapper
// holds its window. The window is looked up again after the read, which can outlast a reload. The slot is
// recorded BEFORE the read: an edit landing during the read then reads as a change on the next check and
// is pushed again, where recording it after would let that edit pass as already shown. A push the turn's
// write would undo waits for that write (shouldMenuPushWait, holdPushForWrite); READY's never does.
async function pushTo(entry, reason, { isMenuStarting = false } = {}) {
    if (shouldMenuPushWait({ isMenuStarting, isWriteDue: isReplyWriteDue(entry.mid) })) {
        holdPushForWrite(entry, reason);
        return;
    }
    entry.pushedSlot = currentStateSlot(entry.mid);
    if (!menuWindowOf(entry.frame.contentWindow)) return;
    const mvuData = await mvuDataFor(entry.mid);
    const win = menuWindowOf(entry.frame.contentWindow);
    if (!win) return;
    try {
        win.postMessage({ type: MENU_STATE_MESSAGE, mid: entry.mid, statData: mvuData.stat_data }, '*');
    } catch (e) {
        log.child('frame').warn('could not push state to "' + entry.rowName + '" on message ' + entry.mid + ' (' + reason + '):', e);
    }
}

// A push held until the turn's write has ended: then dropped when the menu left the page (the write re-rendered
// its message, or the chat moved on; the menu mounted in its place asks for its state when it is ready), or
// sent when it is still there. One held push per frame: a later one joins it, and the send reads the state
// of its own moment.
function holdPushForWrite(entry, reason) {
    if (entry.heldPushReason) return;
    entry.heldPushReason = reason;
    log.child('frame').verbose('message ' + entry.mid + ': the turn\'s write is about to re-render it — the state push to "' + entry.rowName + '" (' + reason + ') waits for that write');
    dueReplyWriteEnded(entry.mid).then(() => {
        const held = entry.heldPushReason;
        entry.heldPushReason = null;
        if (!entry.frame.isConnected) {
            log.child('frame').verbose('message ' + entry.mid + ': "' + entry.rowName + '" left the page before the turn\'s write ended — the held state push (' + held + ') was dropped');
            return;
        }
        return pushTo(entry, held + ', held for the turn\'s write');
    }).catch((e) => log.child('frame').warn('a state push held for the turn\'s write failed for message ' + entry.mid + ':', e));
}

// The unwrapped documents, cached against the body text each came from — the entries are read on
// every mount (they are the truth), the unwrap runs once per text.
const documentCache = new Map();   // rowName -> { text, body, problem }
const problemWarned = new Set();

// The lifted documents off the card: standalone book first (the authoritative copy), the embedded
// character_book as the CHAT_CHANGED-gap fallback — the same read order as the engine text.
async function menuBodiesOnCard() {
    let bodies = await readMenuBodies();
    if (bodies === null) bodies = readEmbeddedMenuBodies();
    return bodies || {};
}

// ONE row's document: { body, problem } — body null with problem null means "no such lifted row".
async function menuDocument(rowName) {
    const text = String((await menuBodiesOnCard())[rowName] || '');
    if (!text) return { body: null, problem: null };
    const cached = documentCache.get(rowName);
    if (!cached || cached.text !== text) {
        const regionName = (text.match(/<!-- mvu-helper:begin ([a-z][a-z0-9-]*) -->/) || [])[1] || '';
        const { body, problem } = regionName ? unwrapRenderedRegion(text, regionName) : { body: null, problem: 'no region marker in the stored text' };
        documentCache.set(rowName, { text, body, problem });
    }
    const doc = documentCache.get(rowName);
    if (doc.problem && !problemWarned.has(rowName)) {
        problemWarned.add(rowName);
        log.child('frame').warn('' + menuBodyComment(rowName) + ' does not hold a liftable row — ' + doc.problem
            + '. The entry was written by the lift at install and is not meant to be edited; re-activate the StatusMenu pack to rewrite it.');
    }
    return doc;
}

function imageSourcesSetting() {
    const value = getGlobal()[MENU_IMAGE_SOURCES_SETTING];
    return typeof value === 'string' ? value : MENU_FRAME_IMAGE_SOURCES_DEFAULT;
}

// The message's MvuData, reduced to what a menu reads. `{ stat_data: null }` when MVU or the message
// is not there — the push then sends an empty state rather than none, and the next push fills it.
async function mvuDataFor(mid) {
    const Mvu = getMvu();
    if (!Mvu || typeof Mvu.getMvuData !== 'function' || !(mid >= 0)) return { stat_data: null };
    try {
        const data = await Mvu.getMvuData({ type: 'message', message_id: mid });
        return { stat_data: (data && data.stat_data) || null };
    } catch (e) {
        log.child('frame').warn('Mvu.getMvuData threw for message ' + mid + ' — this push sends no stat_data:', e);
        return { stat_data: null };
    }
}

/**
 * The contained frame's source for ONE mount of ONE lifted row — the ONE composition of CSP + prelude
 * + document (M8, D11), inside the wrapper that keeps the menu frame on that document. Published on
 * globalThis.MvuHelper so galgame-companion sets `sandbox` and `srcdoc` on a frame it owns and never
 * handles the document itself; through the wrapper's relay the frame still speaks for the menu. `null`
 * when the card has no such lifted row.
 *
 * @param {{ rowName?: string, mid?: number, statData?: object|null }} [initial]  `rowName` is the regex
 *   row's script_name (default: the builder's shell row, 'StatusMenu'); `mid`/`statData` are baked into
 *   the prelude, and later state arrives as MENU_STATE_MESSAGE pushes from whoever owns the frame. This
 *   host's own mounts pass no `statData` (file header, STATE); a host mounting one frame may pass it.
 * @returns {Promise<{ sandbox: string, srcdoc: string } | null>}
 */
export async function statusMenuFrameSource({ rowName = DEFAULT_ROW_NAME, mid = -1, statData = null } = {}) {
    const doc = await menuDocument(String(rowName || DEFAULT_ROW_NAME));
    if (!doc.body) return null;
    const csp = buildMenuFrameCsp({ imageSources: imageSourcesSetting() });
    const prelude = menuFramePrelude({ mid, mvuData: { stat_data: statData } });
    // MACROS, as SillyTavern's regex engine expanded them: runRegexScript ends every replacement with
    // substituteParams, so a {{user}} in the shipped row reached the screen as the persona's name. The
    // lifted document is no longer a replacement, so that one call is made here, at mount — and only
    // that one: {{match}} and $1/$<name> named the text a placeholder matched, which a document mounted
    // by itself has none of, and expanding them would mangle `$1` in the document's own script.
    const body = substituteParams(doc.body);
    const menuSrcdoc = composeMenuFrameSrcdoc({ csp, prelude, body });
    return { sandbox: MENU_FRAME_SANDBOX, srcdoc: composeMenuFrameWrapperSrcdoc({ menuSrcdoc, title: String(rowName || DEFAULT_ROW_NAME) }) };
}

// Mount into ONE container, with no stat_data in the srcdoc (file header, STATE): the push the menu asks
// for when it is ready delivers the message's state. The container is stamped BEFORE the await so a
// second sweep arriving mid-mount cannot mount twice; a failed mount un-stamps so the next sweep retries.
async function mountInto(region, mid, reason) {
    region.setAttribute(MOUNTED_ATTRIBUTE, '1');
    const packId = region.getAttribute(MENU_MOUNT_ATTRIBUTE) || '';
    const rowName = region.getAttribute(MENU_MOUNT_ROW_ATTRIBUTE) || DEFAULT_ROW_NAME;
    // The slot the ready push will send: the check has nothing to push to this frame before the menu is ready.
    const mountSlot = currentStateSlot(mid);
    const source = await statusMenuFrameSource({ rowName, mid });
    if (!source) {
        region.removeAttribute(MOUNTED_ATTRIBUTE);
        log.child('frame').warn('message ' + mid + ' carries the marker row "' + rowName + '" for "' + packId + '" but the card has no ' + menuBodyComment(rowName) + ' to mount'
            + ' — the row was installed before the lift, or the entry was deleted. Re-activate the StatusMenu pack.');
        return;
    }
    if (!region.isConnected) { region.removeAttribute(MOUNTED_ATTRIBUTE); return; }   // re-rendered while we read

    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', source.sandbox);
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('title', rowName);
    frame.style.cssText = MENU_FRAME_STYLE;
    frame.srcdoc = source.srcdoc;
    region.appendChild(frame);
    const entry = { frame, mid, packId, rowName, height: 0, lifted: false, savedStyle: '', loads: 0, pushedSlot: mountSlot, heldPushReason: null };
    frames.set(frame, entry);
    startStateCheck();
    frame.addEventListener('load', () => {
        try { checkFrameVisibility(frame, mid, FRAME_LABEL + ':' + rowName); }
        catch (e) { log.child('frame').warn('visibility check failed for message ' + mid + ':', e); }
        onMenuLoad(entry, 'the frame was moved');
    });
    log.child('frame').lifecycle('mounted "' + rowName + '" of "' + packId + '" on message ' + mid + ' (' + reason + ', ' + source.srcdoc.length + ' chars, sandbox="' + source.sandbox + '")');
}

// One load of a menu: the frame element's own (the wrapper loaded — the mount, or a move), or the
// wrapper's report that the menu frame inside it loaded again by itself. A load drops a lift (a reloaded
// document has no popup open) and pushes nothing: a reloaded menu starts over from an empty state and asks
// for the current one when it is ready (file header, STATE), which is before its load.
function onMenuLoad(entry, cause) {
    entry.loads += 1;
    applyLiftStep(entry, 'load');
    if (entry.loads > 1) log.child('frame').verbose('"' + entry.rowName + '" on message ' + entry.mid + ' reloaded (' + cause + ')');
}

// The menu's prelude has run (READY): its document has started, and its message listener is in. It holds
// no state yet, so this push never waits for the turn's write.
function onMenuReady(entry) {
    pushTo(entry, 'menu ready', { isMenuStarting: true }).catch((e) => log.child('frame').warn('state push to a ready menu failed:', e));
}

// ── an edit no event announces (statusmenu-frame-core.js) ──────────────────
let stateCheckTimer = null;

function startStateCheck() {
    if (!stateCheckTimer) stateCheckTimer = setInterval(checkMenuStates, MENU_STATE_CHECK_MS);
}

function stopStateCheck() {
    if (stateCheckTimer) { clearInterval(stateCheckTimer); stateCheckTimer = null; }
}

function checkMenuStates() {
    for (const element of [...frames.keys()]) {
        if (!element.isConnected) frames.delete(element);
    }
    if (!frames.size) { stopStateCheck(); return; }
    const ctx = chatContext('statusmenu-frame');
    for (const entry of menuStatesToPush([...frames.values()], ctx && ctx.chat)) {
        log.child('frame').verbose('message ' + entry.mid + ': its variables were replaced with no event (an edit) — pushing to "' + entry.rowName + '"');
        pushTo(entry, 'variables edited').catch((e) => log.child('frame').warn('state push after an edit failed:', e));
    }
}

// Every marker-form container that has no frame yet, on whatever message carries it. Oldest first,
// so a chat that renders several at once fills the way the reader reads.
async function mountPending(reason) {
    // The region sits in its OWNER before a frame goes in: moving an element that contains an iframe
    // reloads the iframe, so placement runs first, not after.
    restoreEnclosedRegions();
    const pending = [];
    for (const region of document.querySelectorAll(regionSelector() + '[' + MENU_MOUNT_ATTRIBUTE + ']')) {
        if (region.hasAttribute(MOUNTED_ATTRIBUTE)) continue;
        const mes = region.closest('.mes');
        const mid = mes ? Number(mes.getAttribute('mesid')) : NaN;
        if (!Number.isFinite(mid)) continue;
        pending.push({ region, mid });
    }
    pending.sort((a, b) => a.mid - b.mid);
    for (const { region, mid } of pending) {
        await mountInto(region, mid, reason);
    }
}

/**
 * The message a mounted frame belongs to, or null when the window is not one of ours.
 *
 * Exported for the DISPATCHER, which receives an action as a postMessage and has only `event.source`
 * to go on: whether that frame may WRITE depends on which message it sits on, and this file is the
 * only one that knows. Kept to the id — handing out the entry would let a caller reach the frame.
 */
export function menuFrameMessageId(source) {
    const entry = entryForSource(source);
    return entry ? entry.mid : null;
}

/**
 * The contained menu frame `source` belongs to, as `{ element, role }`, or null: one this host mounted,
 * or a second host's (galgame-companion mounts its own from statusMenuFrameSource), known by the sandbox
 * the frame element carries. `role` is which of the frame's windows `source` is (menuFrameWindowRole).
 */
function containedMenuFrameOf(source) {
    if (!source) return null;
    for (const element of document.querySelectorAll('iframe')) {
        const role = menuFrameWindowRole(source, element.contentWindow);
        if (role) return isMenuFrameSandbox(element.getAttribute('sandbox')) ? { element, role } : null;
    }
    return null;
}

/**
 * Whether `source` is a window of a contained menu frame on this page (containedMenuFrameOf). Exported
 * for the dispatcher, which answers a bridge request from a menu frame and from no other window on the
 * page.
 */
export function isContainedMenuFrame(source) {
    return containedMenuFrameOf(source) !== null;
}

/**
 * Push the current stat_data to every frame this host mounted — each frame gets ITS message's data.
 * Exported for the dispatcher: a menu action persists through Mvu.replaceMvuData, which emits no
 * VARIABLE_UPDATE_ENDED, so the frame would otherwise keep showing the pre-action state.
 */
export async function pushMenuState(reason) {
    for (const [element, entry] of frames) {
        if (!element.isConnected) { frames.delete(element); continue; }
        await pushTo(entry, reason);
    }
}

// One lift event on one frame (menuFrameLiftStep decides). A lift saves the resting style, applies the
// lifted one and puts the frame in the top layer; a drop undoes all three.
function applyLiftStep(entry, event) {
    const step = menuFrameLiftStep(entry.lifted, event);
    if (step === 'lift') {
        entry.savedStyle = entry.frame.style.cssText;
        entry.frame.style.cssText = MENU_FRAME_LIFTED_STYLE;
        entry.lifted = true;
        showInTopLayer(entry);
    } else if (step === 'drop') {
        hideFromTopLayer(entry);
        entry.frame.style.cssText = entry.savedStyle;
        entry.lifted = false;
        if (entry.height) entry.frame.style.height = entry.height + 'px';
        if (event === 'load') log.child('frame').verbose('"' + entry.rowName + '" on message ' + entry.mid + ' reloaded while its popup was open — lift dropped');
    }
}

let topLayerWarned = false;

// A manual popover: no light dismiss and no Escape close, so the menu's own close button stays the one
// way out, as it is at rest.
function showInTopLayer(entry) {
    const frame = entry.frame;
    if (typeof frame.showPopover !== 'function') {
        if (!topLayerWarned) {
            topLayerWarned = true;
            log.child('frame').warn('this browser has no Popover API, so a menu popup opens UNDER SillyTavern\'s top bar and send form');
        }
        return;
    }
    try {
        frame.setAttribute('popover', 'manual');
        frame.showPopover();
    } catch (e) {
        // an unopened popover is display:none, so the attribute cannot stay behind a failed show
        frame.removeAttribute('popover');
        log.child('frame').warn('could not put "' + entry.rowName + '" on message ' + entry.mid + ' in the top layer — its popup opens under SillyTavern\'s bars:', e);
    }
}

function hideFromTopLayer(entry) {
    const frame = entry.frame;
    if (!frame.hasAttribute('popover')) return;
    try {
        if (frame.matches(':popover-open')) frame.hidePopover();
    } catch (e) {
        log.child('frame').warn('could not take "' + entry.rowName + '" on message ' + entry.mid + ' out of the top layer:', e);
    }
    frame.removeAttribute('popover');
}

const BLOCKED_LOAD_NOTE = 'a menu frame shows its own document only';

function onFrameMessage(event) {
    const msg = readMenuFrameMessage(event.data);
    if (!msg.mine) return;
    const entry = entryForSource(event.source);
    if (!entry) {
        // A menu frame a second host mounted (galgame-companion's): its height, overlay and errors are that
        // host's to answer, but a load its wrapper refused is this containment at work, said here.
        const foreign = msg.ok && msg.kind === 'blocked' ? containedMenuFrameOf(event.source) : null;
        if (foreign && foreign.role === 'frame') log.child('frame').warn('a menu frame another host mounted tried to load ' + (msg.url || 'another page') + ' — refused: ' + BLOCKED_LOAD_NOTE);
        return;
    }
    if (!msg.ok) {
        log.child('frame').warn('"' + entry.rowName + '" on message ' + entry.mid + ' sent a malformed ' + msg.kind + ' message — ignored: ' + msg.reason);
        return;
    }
    // The wrapper's own two messages count only from the wrapper: its relay passes neither type from the
    // menu, so one arriving from the menu's window was posted past the wrapper, to window.top.
    if ((msg.kind === 'blocked' || msg.kind === 'reloaded') && menuFrameWindowRole(event.source, entry.frame.contentWindow) !== 'frame') {
        log.child('frame').warn('"' + entry.rowName + '" on message ' + entry.mid + ' posted the wrapper\'s own ' + msg.kind + ' message itself — ignored');
        return;
    }
    if (msg.kind === 'blocked') {
        log.child('frame').warn('"' + entry.rowName + '" of "' + entry.packId + '" on message ' + entry.mid + ' tried to load ' + (msg.url || 'another page')
            + ' — refused: ' + BLOCKED_LOAD_NOTE + '. It shows the browser\'s error page until its message is rendered again.');
        return;
    }
    if (msg.kind === 'ready') {
        onMenuReady(entry);
        return;
    }
    if (msg.kind === 'reloaded') {
        onMenuLoad(entry, 'the menu frame loaded again inside its wrapper');
        return;
    }
    if (msg.kind === 'height') {
        entry.height = msg.height;
        if (!entry.lifted) entry.frame.style.height = msg.height + 'px';
        return;
    }
    if (msg.kind === 'overlay') {
        applyLiftStep(entry, msg.open ? 'overlay-open' : 'overlay-closed');
        return;
    }
    // kind === 'error' — the one line that tells a pre-fix export from a bug in the document itself.
    const verdict = menuFrameErrorVerdict(msg);
    if (verdict === 'image') {
        log.child('frame').warn('"' + entry.rowName + '" on message ' + entry.mid + ': ' + msg.message);
        return;
    }
    const crossOrigin = verdict === 'cross-origin';
    log.child('frame').warn('"' + entry.rowName + '" of "' + entry.packId + '" on message ' + entry.mid + ' threw: ' + msg.message
        + (msg.source ? ' (' + msg.source + ':' + msg.line + ')' : '')
        + ' — ' + (crossOrigin
            ? 'this document reads window.parent directly, which a contained frame refuses; re-export it with MvuStatMenuBuilder 2.5.2 or later, or guard the read (plans/executed/statusmenu-containment.md §5). It is NOT re-hosted uncontained.'
            : 'a fault in the document itself — a TavernHelper function it still calls, or its own bug; the frame stays up with whatever rendered.'));
}

// M7 — the gate's edge, said out loud once per chat. Every recorded row that still carries a document,
// and every foreign claimant of the menu placeholder that does, is rendered by TavernHelper uncontained;
// this names each one and whose fix it is. A quiet card says nothing.
const auditedThisChat = new Set();
async function auditMenuRowsOnCard() {
    if (!isRegexApiAvailable()) return;
    const entries = await getStandaloneLorebookEntries();
    const registry = entries ? readMenuRegistryFrom(entries).registry : null;
    const rows = await getRegexes(REGEX_SCOPE_CHARACTER);
    const findings = auditMenuRows({ cardRegexes: rows, installedRegexNames: registry ? registry.installedRegexNames : [] });
    for (const { name, verdict } of findings) {
        const key = verdict + ':' + name;
        if (auditedThisChat.has(key)) continue;
        auditedThisChat.add(key);
        if (verdict === 'pre-lift') {
            log.child('frame').warn('regex "' + name + '" on this card still carries its document — it was installed BEFORE the containment lift,'
                + ' so TavernHelper renders it UNCONTAINED with the page\'s full authority. Re-activate the StatusMenu pack to lift it into ' + menuBodyComment(name)
                + ' (plans/executed/statusmenu-containment.md M7; there is no migration — mvu-helper is unreleased).');
        } else {
            log.child('frame').warn('regex "' + name + '" claims the menu placeholder on this card but was NOT installed by mvu-helper\'s pack lane'
                + ' — TavernHelper renders it UNCONTAINED with the page\'s full authority, and mvu-helper cannot contain what it did not write.'
                + ' Install the menu through a StatusMenu pack, or remove the row (plans/executed/statusmenu-containment.md §4).');
        }
    }
}

// The sweep is scheduled off the event so the DOM the event announces is in place (ST re-renders a
// message after MESSAGE_EDITED/SWIPED, and TavernHelper waits a tick for the same reason).
function scheduleSweep(reason) {
    setTimeout(() => {
        mountPending(reason).catch((e) => log.child('frame').warn('mount sweep (' + reason + ') failed:', e));
    }, 0);
}

export function wireStatusMenuFrame() {
    if (!eventSource || !event_types) return;
    window.addEventListener('message', onFrameMessage);

    for (const name of ['CHARACTER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MORE_MESSAGES_LOADED']) {
        if (event_types[name]) eventSource.on(event_types[name], () => scheduleSweep(name));
    }
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            frames.clear();
            stopStateCheck();
            documentCache.clear();
            problemWarned.clear();
            auditedThisChat.clear();
            scheduleSweep('CHAT_CHANGED');
            // The regex API attaches after the chat lands; the audit waits for it rather than racing it.
            setTimeout(() => {
                auditMenuRowsOnCard().catch((e) => log.child('frame').warn('the menu-row audit failed:', e));
            }, 1500);
        });
    }
    // The state pushes (file header, STATE). Each push re-reads the reply's stored state, so a later one
    // corrects an earlier: the MVU event fires during the parse, RES-staged once RES1 has resolved, and
    // MVU_STATE_SAVED_EVENT once a save has landed.
    eventSource.on(MENU_MVU_READY_EVENT, () => { pushMenuState('Mvu initialized').catch((e) => log.child('frame').warn('state push failed:', e)); });
    eventSource.on(MVU_VARIABLE_UPDATE_ENDED, () => { pushMenuState('VARIABLE_UPDATE_ENDED').catch((e) => log.child('frame').warn('state push failed:', e)); });
    eventSource.on(RES_STAGED_EVENT, () => { pushMenuState('RES staged').catch((e) => log.child('frame').warn('state push failed:', e)); });
    eventSource.on(MVU_STATE_SAVED_EVENT, () => { pushMenuState('state saved').catch((e) => log.child('frame').warn('state push failed:', e)); });
    scheduleSweep('startup');
}
