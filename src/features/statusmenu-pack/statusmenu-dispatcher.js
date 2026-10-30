// statusmenu-pack/statusmenu-dispatcher.js — the menu's write lane (§9.4, G3.5).
//
// A menu button is a USER GESTURE, not a turn. The flow:
//   menu iframe --postMessage--> here --Worker RPC--> the action --patches--> Mvu --> persist
// The action itself NEVER writes: §9.5 makes actions `(args, statSnapshot) => patch[]`, pure and
// sandboxed in the Worker, and mvu-helper is the only thing that touches state. That split is what
// lets a community menu ship executable behaviour at all.
//
// ⚠ THE APPLY IS SUPPRESSED, AND THAT IS THE WHOLE DESIGN OF THIS FILE.
// `Mvu.parseMessage` emits VARIABLE_UPDATE_ENDED, which the turn runner treats as "a reply finished,
// resolve it". A menu click is not a reply. Unsuppressed, clicking a button would either
//   • resolve a turn against the last AI floor — a click landing MID-GENERATION would consume Intent
//     the PRE call had already dealt (dice included) before narrate ever rendered it, or
//   • land on the already-handled turnKey and fire the RES2 post-relay path.
// `withLiveResolveSuppressed` is the gate built for exactly this hazard (live-resolve-gate.js) and the
// §23 plugin relay is the precedent.
//
// This is a LIVE-RESOLVE hazard, NOT the card's same-reply protection — do not conflate them. Same-reply
// protection exists so dice dealt BY AN LLM CALL resolve inside the reply that dealt them. A button click
// is event-driven: no LLM call, no reply, nothing of its own that must land before a generation. It has
// no same-reply requirement, so that protection is not in play on this lane at all.
//
// Persisting is ours too, and that is the one thing this lane does NOT share with the relay: the relay
// runs inside VARIABLE_UPDATE_ENDED, where MVU saves afterwards anyway. Nothing saves after a button
// click, so the write is finished with an explicit `replaceMvuData` — which emits no
// VARIABLE_UPDATE_ENDED, so the persist cannot re-enter the runner either.

import { createModuleLog } from '../../sillytavern/log.js';
import { getMvu, parseMvuBlock, saveMessageMvuData } from '../../sillytavern/mvu-bridge.js';
import { refusedByPhrase } from '../../sillytavern/mvu-bridge-core.js';
import { getContext } from '../../../../../../extensions.js';
import { withLiveResolveSuppressed, getEngineScopeApi, callEngineScopeBatch } from '../logic-engine/index.js';
import { latestAiMessageId } from '../../shared/latest-reply.js';
import { opsOutcomeAfterApply, renderOpOutcome } from '../../shared/json-patch-ops.js';
import { readMenuActionRequest, readMenuActionInputsRequest, readMenuFormatterRequest, validateMenuPatches, validateMenuInputs, toMvuPatchOps, MENU_ACTION_MESSAGE, MENU_ACTION_INPUTS_MESSAGE, MENU_FORMATTER_MESSAGE } from './statusmenu-pack-core.js';
import { MENU_ENGINE_SCOPE, runMenuFormatterPrePass } from './statusmenu-engine-runtime.js';
import { readMenuRegistryFrom } from './statusmenu-pack-activation.js';
import { getStandaloneLorebookEntries, getPrimaryLorebookEntries } from '../../sillytavern/lorebook.js';
import {
    readMenuLorebookContentRequest, lorebookContentByKey, MENU_LOREBOOK_CONTENT_MESSAGE,
    readMenuImageRequest, menuImageRequestProblem, MENU_IMAGE_MESSAGE, MENU_IMAGE_MAX_BYTES, MENU_STATE_MESSAGE,
    readMenuLinkRequest, menuLinkOpenVerdict, MENU_LINK_MESSAGE, menuBridgeSenderVerdict,
} from './statusmenu-frame-core.js';
import { pushMenuState, menuFrameMessageId, isContainedMenuFrame } from './statusmenu-frame.js';

const log = createModuleLog('statusmenu-pack');

// The writer label this lane pushes for its parse. It reaches the turn runner's suppression line,
// which NAMES the writer — see the enumeration there (a third writer had to be added to it).
const WRITER_PREFIX = 'statusmenu:';

/**
 * Run ONE menu action end to end. Exported (not just wired to postMessage) so the flow is drivable
 * from a console or a test without a menu iframe — which is how G3.5 is verified at all, since the
 * sender does not exist until the builder's B2.
 *
 * @returns {Promise<{ok: boolean, reason?: string, applied?: number, refused?: string[]}>}
 */
export async function runMenuAction(actionName, args) {
    const active = await activeMenuPackId();
    if (!active.ok) return { ok: false, reason: active.reason };
    const packId = active.packId;

    // 1. Does the action EXIST? Asked before anything is read or written, so a menu built for another
    //    engine is refused by name instead of failing somewhere less legible (§10a's rule at the
    //    action surface: name it, never break).
    const found = resolveMenuAction(actionName, packId);
    if (!found.ok) return { ok: false, reason: found.reason };
    const { exportName } = found;

    // 2. Snapshot the state the action reasons about. It crosses to the Worker by structured clone, so
    //    the action can never hold a live reference into the page's data.
    const live = await readMenuStatData();
    if (!live.ok) return { ok: false, reason: live.reason };
    const { mid, mvuData, statData } = live;

    // 3. Run it in the Worker. callBatch is used for ONE call on purpose: it is the containment path —
    //    a throwing action comes back as a marked entry instead of rejecting, so a broken menu action
    //    cannot take the page down with it.
    const results = await callEngineScopeBatch(MENU_ENGINE_SCOPE, [{ name: exportName, args: [args || {}, statData] }]);
    const result = Array.isArray(results) ? results[0] : null;
    if (!result || !result.ok) {
        const why = result && result.error ? result.error : (result && result.missing ? 'the Worker reports it missing' : 'the Worker did not answer');
        log.warn('action "' + actionName + '" (' + packId + ') failed inside the engine — nothing was written: ' + why);
        return { ok: false, reason: 'the action threw inside the engine: ' + why };
    }

    // 4. SHAPE the return. One malformed patch refuses the WHOLE action: an action is one user
    //    gesture, and half of it leaves state its author never designed (§9.4, V2 as corrected).
    const verdict = validateMenuPatches(result.value);
    if (!verdict.ok) {
        log.warn('action "' + actionName + '" (' + packId + ') REFUSED — ' + verdict.reason
            + '. Nothing was written; the whole action is refused because applying part of it would leave '
            + 'state the menu author never designed.');
        return { ok: false, reason: verdict.reason };
    }
    if (!verdict.patches.length) {
        log.domain('pipeline', 'lifecycle', 'action "' + actionName + '" (' + packId + ') returned no patches — nothing to write');
        return { ok: true, applied: 0, refused: [] };
    }

    // 5. Apply through the SAME rail as the card's own bookkeeper, suppressed (see the file header).
    const ops = toMvuPatchOps(verdict.patches);
    const applied = await withLiveResolveSuppressed(
        () => parseMvuBlock('<UpdateVariable>\n<JSONPatch>\n' + JSON.stringify(ops) + '\n</JSONPatch>\n</UpdateVariable>',
            mvuData, { writer: WRITER_PREFIX + packId }));
    if (!applied) {
        log.warn('action "' + actionName + '" (' + packId + '): MVU applied NONE of its '
            + ops.length + ' op(s) — every one was refused, or MVU is unavailable');
        return { ok: false, reason: 'MVU applied nothing' };
    }

    // 6. Persist. Explicit target, and it emits no VARIABLE_UPDATE_ENDED, so the save cannot re-enter
    //    the turn runner the suppression above just held off. The door announces the save to every
    //    reader that shows state; the acting menu is pushed here as well, awaited, so it re-renders with
    //    what it just wrote before the action answers (containment M5).
    await saveMessageMvuData(applied, mid, { writer: WRITER_PREFIX + packId });
    await pushMenuState('action ' + actionName);

    // 7. ENUMERATE what landed (§9.4). Every op, with the pack id — a count alone would let a
    //    half-refused action read as a success. By VALUE, not by path presence: this lane is where
    //    presence was caught lying (2026-08-28 — `wrote 1/1 op(s) -> add /Mainchar/Money=5001` while
    //    the persisted value stayed `[5000,"Money"]`). `mvuData.stat_data` is still the pre-apply
    //    state, because Mvu.parseMessage clones before it writes.
    const outcomes = opsOutcomeAfterApply(mvuData.stat_data, applied.stat_data, ops);
    const refused = outcomes.filter((r) => r.state === 'refused' || r.state === 'absent').map((r) => r.path);
    const landed = outcomes.filter((r) => r.state === 'landed' || r.state === 'coerced' || r.state === 'changed').length;
    log.domain('pipeline', 'lifecycle', 'action "' + actionName + '" (' + packId + ') landed '
        + landed + '/' + ops.length + ' op(s) -> msg ' + mid + ': ' + outcomes.map(renderOpOutcome).join(' · '));
    if (refused.length) {
        log.warn('action "' + actionName + '" (' + packId + '): ' + refused.length
            + ' op(s) did NOT take — the value stored is not the value sent. ' + refusedByPhrase(applied)
            + ' (or the op shape does not fit what is there): ' + refused.join(', '));
    }
    return { ok: true, applied: landed, refused, outcomes, mid, statData: applied.stat_data };
}

// The active StatusMenu Pack's id, or why there is none — the first question every lane asks.
async function activeMenuPackId() {
    const entries = await getStandaloneLorebookEntries();
    const registry = entries ? readMenuRegistryFrom(entries).registry : null;
    if (!registry) return { ok: false, reason: 'no StatusMenu Pack is active on this card' };
    return { ok: true, packId: registry.activeMenuId };
}

// Does the hosted engine export this action? ONE spelling of the refusal, because the inputs lane
// asks the same question first: a row verb whose name is a typo fails at its first click with this
// reason, before any form is drawn.
function resolveMenuAction(actionName, packId) {
    const api = getEngineScopeApi(MENU_ENGINE_SCOPE);
    if (!api) return { ok: false, reason: 'no StatusMenu Engine is hosted — nothing can answer "' + actionName + '"' };
    const exportName = 'actions.' + actionName;
    if (typeof api[exportName] !== 'function') {
        const known = Object.keys(api).filter((k) => k.startsWith('actions.')).map((k) => k.slice('actions.'.length));
        return { ok: false, reason: '"' + packId + '" exports no action "' + actionName + '" (it has: ' + (known.join(', ') || 'none') + ')' };
    }
    return { ok: true, api, exportName };
}

/**
 * What ONE action needs from the player, asked at click time (D8). Reads `inputs.<name>(args, root)`
 * in the Worker against the live snapshot and relays the declaration verbatim after a SHAPE check.
 * READ-ONLY — nothing here can write, so it needs none of the action lane's suppression. No
 * declaration is not an error: most verbs take exactly what the row posted, and asking each of them
 * to say so would be a namespace of boilerplate. Exported for the same reason runMenuAction is.
 *
 * @returns {Promise<{ok: boolean, reason?: string, inputs?: object[]}>}
 */
export async function runMenuActionInputs(actionName, args) {
    const active = await activeMenuPackId();
    if (!active.ok) return { ok: false, reason: active.reason };
    const packId = active.packId;
    const found = resolveMenuAction(actionName, packId);
    if (!found.ok) return { ok: false, reason: found.reason };
    const inputsName = 'inputs.' + actionName;
    if (typeof found.api[inputsName] !== 'function') return { ok: true, inputs: [] };

    const live = await readMenuStatData();
    if (!live.ok) return { ok: false, reason: live.reason };
    const results = await callEngineScopeBatch(MENU_ENGINE_SCOPE, [{ name: inputsName, args: [args || {}, live.statData] }]);
    const result = Array.isArray(results) ? results[0] : null;
    if (!result || !result.ok) {
        const why = result && result.error ? result.error : (result && result.missing ? 'the Worker reports it missing' : 'the Worker did not answer');
        log.warn('inputs for "' + actionName + '" (' + packId + ') failed inside the engine — nothing asked: ' + why);
        return { ok: false, reason: 'the inputs declaration threw inside the engine: ' + why };
    }
    const verdict = validateMenuInputs(result.value);
    if (!verdict.ok) {
        log.warn('inputs for "' + actionName + '" (' + packId + ') REFUSED — ' + verdict.reason
            + '. The form draws nothing; a half-drawn form would ask for half a verb.');
        return { ok: false, reason: verdict.reason };
    }
    log.domain('pipeline', 'verbose', 'inputs for "' + actionName + '" (' + packId + '): '
        + verdict.inputs.length + ' input(s) ' + verdict.inputs.map((i) => i.name + ':' + i.kind).join(', '));
    return { ok: true, inputs: verdict.inputs };
}

// One message's stat_data, and which message that was — shared by the action lane and the formatter
// batch, which need DIFFERENT messages and say so at the call.
//
// The ACTION lane always takes the default. Which message a write lands on is the TURN RUNNER's
// answer, through the barrel: the same answer by construction, or a menu would write a different
// message than the turn resolves against.
//
// The FORMATTER lane passes the ASKING FRAME's message, because a menu mounted on an older reply is
// showing that reply's stats — the reason those frames exist at all. Resolving its formatters
// against the newest message instead would render one menu out of two turns: baked history for every
// plain value, today's numbers for anything a formatter computed, with nothing marking the seam.
// Read-only, so pointing it at an older message risks nothing a write would.
async function readMenuStatData(messageId) {
    const Mvu = getMvu();
    if (!Mvu || typeof Mvu.getMvuData !== 'function' || typeof Mvu.replaceMvuData !== 'function') {
        return { ok: false, reason: 'MVU is unavailable' };
    }
    const ctx = getContext();
    const mid = Number.isFinite(messageId) ? Number(messageId) : latestAiMessageId(ctx && ctx.chat);
    if (mid < 0) return { ok: false, reason: 'no message to act on yet' };
    const mvuData = await Mvu.getMvuData({ type: 'message', message_id: mid });
    const statData = mvuData && mvuData.stat_data;
    if (!statData || typeof statData !== 'object') return { ok: false, reason: 'this message carries no stat_data' };
    return { ok: true, Mvu, mid, mvuData, statData };
}

/**
 * Resolve ONE formatter batch for a menu renderer: read the live snapshot, hand the caller-built
 * requests to the pre-pass (ONE Worker round trip), return its map. READ-ONLY — nothing here can
 * write, which is why this lane needs none of the action lane's suppression.
 * Exported for the same reason runMenuAction is: drivable without a menu iframe.
 *
 * @returns {Promise<{ok: boolean, reason?: string, map?: Record<string, string>, missing?: string[]}>}
 */
export async function runMenuFormatterBatch(requests, messageId) {
    const live = await readMenuStatData(messageId);
    if (!live.ok) return { ok: false, reason: live.reason };
    const result = await runMenuFormatterPrePass(live.statData, requests);
    if (!result) return { ok: false, reason: 'the batch resolved to nothing' };
    log.domain('pipeline', 'verbose', 'formatter batch: ' + requests.length + ' request(s), '
        + Object.keys(result.map).length + ' resolved, ' + result.missing.length + ' missing');
    return { ok: true, map: result.map, missing: result.missing };
}

// The mediated SillyTavern image read (statusmenu-frame-core.js readMenuImageRequest): a GET of a
// same-origin URL outside /api/, answered with the bytes ONLY when the response is image/* and under
// the size cap. Anything else answers a reason — never the body — so the channel cannot read a
// non-image resource even by asking for one.
async function readSillyTavernImage(url) {
    const where = menuImageRequestProblem(url, window.location.origin);
    if (!where.ok) return { reason: where.reason };
    const response = await fetch(where.href, { credentials: 'same-origin' });
    if (!response.ok) return { reason: 'SillyTavern answered ' + response.status };
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('image/')) return { reason: 'not an image (' + (type || 'no content-type') + ')' };
    const blob = await response.blob();
    if (blob.size > MENU_IMAGE_MAX_BYTES) return { reason: 'larger than ' + Math.round(MENU_IMAGE_MAX_BYTES / 1048576) + ' MB' };
    return { blob };
}

// ── the wire (postMessage) ───────────────────────────────────────────────────

// The requests a menu frame makes of the page — every lane below. Answered for a contained menu frame
// only (menuBridgeSenderVerdict), whichever host mounted it.
const MENU_BRIDGE_REQUEST_TYPES = new Set([
    MENU_LOREBOOK_CONTENT_MESSAGE, MENU_IMAGE_MESSAGE, MENU_LINK_MESSAGE,
    MENU_FORMATTER_MESSAGE, MENU_ACTION_INPUTS_MESSAGE, MENU_ACTION_MESSAGE,
]);

// One listener for the page. A menu iframe posts an action request; anything else on the window is
// ignored in silence (readMenuActionRequest separates "not ours" from "ours and malformed", because
// the window carries SillyTavern's own traffic and every other extension's).
//
// No origin allow-list: the menu runs in an `about:srcdoc` iframe whose origin is "null", so an origin
// test would refuse the only legitimate sender. The SENDER is checked instead, before any lane reads
// the request: a bridge request from any window but a contained menu frame's (isContainedMenuFrame — an
// iframe carrying the menu sandbox: its own window, which relays what the menu posts to its parent, or
// the menu's inside it, which posts to window.top directly) is refused and logged as a warning. One whose
// sender no longer exists (no `source`: a menu removed by a re-render of its message after it posted) is
// unanswered too, and logged at verbose, because that race is part of every turn's end. Past that, the
// bound is what an action can DO — the name must be an export of the installed engine, the code runs
// sandboxed in the Worker, and every patch it returns is shape-checked and logged before a byte is written.
export function wireStatusMenuDispatcher() {
    window.addEventListener('message', (event) => {
        const sender = menuBridgeSenderVerdict(event && event.data, {
            bridgeTypes: MENU_BRIDGE_REQUEST_TYPES,
            hasSender: Boolean(event && event.source),
            isMenuFrame: () => isContainedMenuFrame(event.source),
        });
        if (sender.isBridge && !sender.ok) {
            if (sender.isSenderGone) log.verbose('a bridge request went unanswered: ' + sender.reason);
            else log.warn('a bridge request was refused: ' + sender.reason);
            return;
        }

        // The mediated lorebook READ (containment D5/M5): a contained menu cannot see the book, so it
        // asks by KEY and gets ONE content string — matched page-side exactly as its own
        // fetchLorebookContent matched client-side, from the card's primary book. Answered for any
        // contained menu frame, ours or a second host's; the answer never carries another entry's fields.
        const lore = readMenuLorebookContentRequest(event && event.data);
        if (lore.mine) {
            if (!lore.ok) {
                log.warn('a menu sent a malformed ' + MENU_LOREBOOK_CONTENT_MESSAGE + ' request — ignored: ' + lore.reason);
                return;
            }
            void getPrimaryLorebookEntries()
                .then((entries) => {
                    const content = lorebookContentByKey(entries, lore.key);
                    log.domain('pipeline', 'verbose', 'lorebook content for "' + lore.key + '": ' + (content === null ? 'no match' : content.length + ' chars'));
                    try {
                        if (event.source && typeof event.source.postMessage === 'function') {
                            event.source.postMessage({ type: MENU_LOREBOOK_CONTENT_MESSAGE + '-result', requestId: lore.requestId, content }, '*');
                        }
                    } catch (e) {
                        log.warn('could not reply to the menu frame with the lorebook content:', e);
                    }
                })
                .catch((e) => {
                    log.error('lorebook content read failed for "' + lore.key + '":', e);
                });
            return;
        }

        const image = readMenuImageRequest(event && event.data);
        if (image.mine) {
            if (!image.ok) {
                log.warn('a menu sent a malformed ' + MENU_IMAGE_MESSAGE + ' request — ignored: ' + image.reason);
                return;
            }
            void readSillyTavernImage(image.url)
                .then((res) => {
                    if (res.reason) log.domain('pipeline', 'verbose', 'image refused for a menu: ' + image.url + ' — ' + res.reason);
                    try {
                        if (event.source && typeof event.source.postMessage === 'function') {
                            event.source.postMessage({ type: MENU_IMAGE_MESSAGE + '-result', requestId: image.requestId, ...res }, '*');
                        }
                    } catch (e) {
                        log.warn('could not reply to the menu frame with the image:', e);
                    }
                })
                .catch((e) => {
                    log.warn('SillyTavern image read failed for ' + image.url + ':', e);
                });
            return;
        }

        // A web link the player clicked in a menu (statusmenu-frame-core.js menuLinkOpenVerdict): opened
        // in a new tab with no opener and no referrer, for a contained menu frame only, only right after
        // a click, and only for http(s). Nothing is answered.
        const link = readMenuLinkRequest(event && event.data);
        if (link.mine) {
            if (!link.ok) {
                log.warn('a menu sent a malformed ' + MENU_LINK_MESSAGE + ' request — ignored: ' + link.reason);
                return;
            }
            const activation = navigator.userActivation;
            const verdict = menuLinkOpenVerdict({
                url: link.url,
                isMenuFrame: isContainedMenuFrame(event.source),
                userActivation: activation ? activation.isActive : null,
            });
            if (!verdict.ok) {
                log.warn('a menu link was not opened: ' + link.url + ' — ' + verdict.reason);
                return;
            }
            window.open(verdict.href, '_blank', 'noopener,noreferrer');
            log.domain('pipeline', 'verbose', 'a menu link opened in a new tab: ' + verdict.href);
            return;
        }

        const batch = readMenuFormatterRequest(event && event.data);
        if (batch.mine) {
            if (!batch.ok) {
                log.warn('a menu sent a malformed ' + MENU_FORMATTER_MESSAGE + ' batch — ignored: ' + batch.reason);
                return;
            }
            // The ASKING frame's message, so a menu on an older reply formats that reply's numbers
            // rather than today's. null (a frame this host did not mount) falls back to the latest.
            const askingMessageId = menuFrameMessageId(event.source);
            void runMenuFormatterBatch(batch.requests, askingMessageId)
                .then((res) => {
                    // A batch that cannot be served is answered with its reason, and said here too.
                    // Expected right after a page load: the menus mount and ask before MVU has loaded,
                    // and ask again when its state is pushed to them.
                    if (!res.ok) {
                        log.lifecycle('formatter batch from ' + (askingMessageId === null ? 'a menu another host mounted' : 'the menu on message ' + askingMessageId)
                            + ' not served: ' + res.reason + ' — its formatter cells show raw values until the menu asks again');
                    }
                    try {
                        if (event.source && typeof event.source.postMessage === 'function') {
                            event.source.postMessage({ type: MENU_FORMATTER_MESSAGE + '-result', requestId: batch.requestId, ...res }, '*');
                        }
                    } catch (e) {
                        log.warn('could not reply to the menu frame with the formatter map:', e);
                    }
                })
                .catch((e) => {
                    log.error('formatter batch failed outside the engine:', e);
                });
            return;
        }

        const asked = readMenuActionInputsRequest(event && event.data);
        if (asked.mine) {
            if (!asked.ok) {
                log.warn('a menu sent a malformed ' + MENU_ACTION_INPUTS_MESSAGE + ' request — ignored: ' + asked.reason);
                return;
            }
            void runMenuActionInputs(asked.action, asked.args)
                .then((res) => {
                    try {
                        if (event.source && typeof event.source.postMessage === 'function') {
                            event.source.postMessage({ type: MENU_ACTION_INPUTS_MESSAGE + '-result', requestId: asked.requestId, ...res }, '*');
                        }
                    } catch (e) {
                        log.warn('could not reply to the menu frame with the inputs declaration:', e);
                    }
                })
                .catch((e) => {
                    log.error('inputs for "' + asked.action + '" failed outside the engine:', e);
                });
            return;
        }

        const request = readMenuActionRequest(event && event.data);
        if (!request.mine) return;
        if (!request.ok) {
            log.warn('a menu sent a malformed ' + MENU_ACTION_MESSAGE + ' request — ignored: ' + request.reason);
            return;
        }
        // A menu on an OLDER reply shows that reply's stats — the reason those frames are kept. But
        // the action lane writes to the LATEST AI message by construction (readMenuStatData), so a
        // button pressed on a historical menu would reason about the state in front of the user and
        // land it on a different turn. Refused HERE, by the asking frame's own message id, because
        // this is the only place the sender is known; refusing it is the honest answer, and the
        // frame gets a reason it can show rather than a click that quietly did something else.
        const askingMessageId = menuFrameMessageId(event.source);
        const liveContext = getContext();
        const liveMessageId = latestAiMessageId(liveContext && liveContext.chat);
        if (askingMessageId !== null && liveMessageId >= 0 && askingMessageId !== liveMessageId) {
            const reason = 'this menu is on message ' + askingMessageId + ', and an action writes to the newest reply ('
                + liveMessageId + ') — it would change a turn this menu is not showing. Use the menu on the newest reply.';
            log.warn('action "' + request.action + '" refused: ' + reason);
            try {
                if (event.source && typeof event.source.postMessage === 'function') {
                    event.source.postMessage({ type: MENU_ACTION_MESSAGE + '-result', requestId: request.requestId, ok: false, reason }, '*');
                }
            } catch (e) {
                log.warn('could not tell the menu frame its action was refused (nothing was written):', e);
            }
            return;
        }

        void runMenuAction(request.action, request.args)
            .then((res) => {
                // Reply to the frame that asked, so a menu can re-render or show its own refusal.
                // Never broadcast: `event.source` is the asking frame and nothing else hears it.
                // A landed action ALSO pushes the new state to that frame first: a contained frame reads
                // only what it is pushed, and a frame another host mounted (galgame-companion's) is
                // outside pushMenuState's reach — the asking frame is the one that must redraw now.
                const { statData, ...reply } = res;
                try {
                    if (event.source && typeof event.source.postMessage === 'function') {
                        if (res.ok && statData) event.source.postMessage({ type: MENU_STATE_MESSAGE, mid: res.mid, statData }, '*');
                        event.source.postMessage({ type: MENU_ACTION_MESSAGE + '-result', requestId: request.requestId, ...reply }, '*');
                    }
                } catch (e) {
                    log.warn('could not reply to the menu frame (the action itself already ran):', e);
                }
            })
            .catch((e) => {
                log.error('action "' + request.action + '" failed outside the engine:', e);
            });
    });
}
