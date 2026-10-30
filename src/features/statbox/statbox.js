// statbox/statbox.js — the StatBox's host half. Reads the card's declaration (the per-card profile's
// `statBox`, imported from [Initmvuhelper]), the baseline and current state from the chat, and hands a
// reply's text back with the box placed. Three moments build it, each refreshing the box already there:
//   - MVU's parse of the reply ends (this file's listener): the box from the state MVU just read, on every
//     card that declares one, with a game engine or without;
//   - the engine's resolved-reply edit (logic-engine), after RES1: the box from RES1's state;
//   - the post-reply phase's end (small-llm): the box from the turn's final stored state.
// Each hands its edit to the reply redraw (features/reply-redraw), which writes it with the turn's other
// edits, so the box costs no render of its own. The box at MVU's parse is announced when the reply arrives
// (statbox-core shouldAwaitBoxAtArrival), so the turn's write waits for that parse.
//
// The decisions are pure and tested in statbox-core.js; this file only gathers their inputs and says
// what happened.

import { eventSource, event_types } from '../../../../../../../script.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { getProfile } from '../../sillytavern/settings-store.js';
import { chatContext } from '../../sillytavern/chat-context.js';
import { currentWriter, MVU_VARIABLE_UPDATE_ENDED } from '../../sillytavern/mvu-bridge-core.js';
import { latestAiMessageId } from '../../shared/latest-reply.js';
import { endedEventDisposition } from '../../shared/mvu-parse-disposition.js';
import { redrawReply, announceReplyEdit } from '../reply-redraw/index.js';
import {
    renderStatBox, placeStatBox, stripStatBox, statBoxBaselineIndex, messageStatData,
    unresolvedStatBoxPaths, isStatBoxParseWriter, shouldBuildStatBoxOnParse, statBoxSectionOf,
    shouldAwaitBoxAtArrival, isAwaitedBoxRendered, expandIdentityMacros,
} from './statbox-core.js';

const log = createModuleLog('statbox');

const warnedPaths = new Set();   // declared paths already reported as resolving to nothing; cleared on chat change

// How long the turn's write may wait for the reply's arrival to end. MVU's parse takes a moment; in MVU's
// extra-model mode it first waits for MVU's own model, and the record's deadline bounds that.
const BOX_AT_PARSE_WAIT_MS = 10_000;
let awaitedBox = null;   // { mid, settle }: the box the turn's write waits for, until its reply is rendered

function activeSection() {
    return statBoxSectionOf(getProfile());
}

/** Does the active card declare a box? A writer with nothing else to write asks before fencing. */
export function isStatBoxDeclared() {
    return activeSection() !== null;
}

// Member names are stored as the card wrote them, macros included (School's player record is named
// `{{user}}`). The box is frozen into the reply's text, which a display may read raw without expanding
// macros, so the box carries the expanded name — `{{user}}` and `{{char}}` only (statbox-core
// expandIdentityMacros says why no other macro runs).
function nameFormatter(ctx) {
    const names = { user: ctx && ctx.name1 != null ? ctx.name1 : '', char: ctx && ctx.name2 != null ? ctx.name2 : '' };
    return (name) => expandIdentityMacros(name, names);
}

/**
 * The reply text with this turn's box placed, or refreshed if an earlier edit already placed one.
 * `statData` is the reply's current state: MVU's parse passes the state it just read and the engine's
 * resolved-reply edit passes RES1's result (neither saved yet); the turn's end omits it and the reply's
 * stored state is read (RES2 has saved by then). Returns `text` unchanged when the card declares no box.
 */
export function composeStatBox(text, { mid, statData = null, writer }) {
    const section = activeSection();
    if (!section) return text;
    const ctx = chatContext('statbox');
    const chat = ctx && Array.isArray(ctx.chat) ? ctx.chat : null;
    if (!chat || !chat[mid]) {
        log.warn(`${writer} msg ${mid}: the reply is not in the chat — box not written`);
        return text;
    }
    const current = statData || messageStatData(chat[mid]);
    if (!current) {
        log.warn(`${writer} msg ${mid}: the reply carries no stat_data — box not written`);
        return text;
    }
    warnUnresolvedPaths(section, current);
    const baseIndex = statBoxBaselineIndex(chat, mid);
    const baseline = baseIndex >= 0 ? messageStatData(chat[baseIndex]) : null;
    const rendered = renderStatBox(section, baseline, current, {
        formatName: nameFormatter(ctx),
        onRefused: ({ key, token }) => log.warn(`${writer} msg ${mid}: the box line for "${key}" carries "${token}" — left out of the box. Its names and values are stat_data, and that token would make the page run the reply's text (a TavernHelper render or an ST-Prompt-Template template)`),
    });
    const res = placeStatBox(text, section, rendered);
    if (res.hit === 'no-anchor') {
        log.warn(`${writer} msg ${mid}: none of the card's placeBefore anchors (${section.placeBefore.join(' ')}) is in the reply, so the box was NOT written — the reply ends without its envelope's closing tag: cut off (a [reply-integrity] TRUNCATED warning names that) or written without the envelope`);
        return text;
    }
    const lines = rendered ? rendered.split('\n').length - section.open.split('\n').length - section.close.split('\n').length : 0;
    log.domain('pipeline', 'lifecycle', `${writer} msg ${mid}: ${res.hit} — ${lines} line(s) against baseline ${baseIndex >= 0 ? `msg ${baseIndex}` : 'none (no earlier reply carries state, so there is no box)'}`);
    return res.text;
}

// A misspelled path prints nothing, so say so — once per path per chat load, not on every reply.
function warnUnresolvedPaths(section, current) {
    for (const { path, why } of unresolvedStatBoxPaths(section, current)) {
        if (warnedPaths.has(path)) continue;
        warnedPaths.add(path);
        log.warn(`the card's statBox declares "${path}", which resolves to nothing — ${why}. Check its spelling against the card's schema.`);
    }
}

/** The text without any box — for readers that must not see it. Unchanged when the card declares none. */
export function stripStatBoxFromText(text) {
    const section = activeSection();
    return section ? stripStatBox(text, section) : String(text == null ? '' : text);
}

// A reply arrived: the box MVU's parse will build is announced to the reply redraw, and settled once SillyTavern
// renders that reply (statbox-core shouldAwaitBoxAtArrival). Synchronous: the turn can end at any await.
function announceBoxAtArrival(messageId) {
    settleAwaitedBox();   // a newer reply arrived: no write waits on the older one
    const ctx = chatContext('statbox');
    const chat = ctx && Array.isArray(ctx.chat) ? ctx.chat : null;
    const mid = Number(messageId);
    const message = chat ? chat[mid] : null;
    if (!shouldAwaitBoxAtArrival({ isDeclared: isStatBoxDeclared(), message })) return;
    let settle = null;
    const rendered = new Promise((resolve) => { settle = resolve; });
    if (announceReplyEdit(message, mid, { label: 'stat box (MVU parse)', work: rendered, allowanceMs: BOX_AT_PARSE_WAIT_MS })) {
        awaitedBox = { mid, settle };
    } else {
        settle();
    }
}

function settleAwaitedBox() {
    if (!awaitedBox) return;
    const { settle } = awaitedBox;
    awaitedBox = null;
    settle();
}

// MVU's parse of a reply ended: the box from the state MVU just read. The text edit lands before this
// returns, and MVU's write-back after its listeners keeps an edit made while they ran
// (devdoc/editing-a-finished-reply.md, MVU1). Which parses build it: statbox-core shouldBuildStatBoxOnParse.
function buildBoxOnParse(mvuData, variablesBefore) {
    if (!isStatBoxDeclared()) return;
    // The parse's writer label is on the stack only while the event's listeners run synchronously.
    const writer = currentWriter();
    if (!isStatBoxParseWriter(writer)) return;
    const ctx = chatContext('statbox');
    const chat = ctx && Array.isArray(ctx.chat) ? ctx.chat : null;
    const { disposition } = endedEventDisposition(variablesBefore && variablesBefore.stat_data, chat);
    const mid = latestAiMessageId(chat);
    if (!shouldBuildStatBoxOnParse({ writer, disposition, mid })) return;
    const statData = mvuData && mvuData.stat_data;
    if (!statData || typeof statData !== 'object') return;
    const message = chat[mid];
    const text = composeStatBox(message.mes, { mid, statData, writer: 'MVU parse' });
    if (text === message.mes) return;
    message.mes = text;
    redrawReply(message, mid, 'stat box')
        .catch((e) => log.warn(`MVU parse msg ${mid}: the box is in the reply's text but could not be handed to the reply redraw:`, e));
}

if (eventSource && event_types) {
    // Registered void: MVU awaits its listeners, and nothing here needs it to.
    eventSource.on(MVU_VARIABLE_UPDATE_ENDED, (mvuData, variablesBefore) => {
        try { buildBoxOnParse(mvuData, variablesBefore); }
        catch (e) { log.warn('building the box on MVU\'s parse failed (the reply keeps the box it had):', e); }
    });
    // The box at MVU's parse joins the turn's one write. small-llm imports this module, so this listener is added
    // before the POST pass's and announces the box before that pass can end the turn.
    if (event_types.MESSAGE_RECEIVED && event_types.CHARACTER_MESSAGE_RENDERED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
            try { announceBoxAtArrival(messageId); }
            catch (e) { log.warn('could not announce the box to the turn\'s write (the box MVU\'s parse builds is written on its own):', e); }
        });
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
            if (isAwaitedBoxRendered(awaitedBox, messageId)) settleAwaitedBox();
        });
    }
    // A new chat may be a new card: nothing warned carries over, and no write waits on the old chat's reply.
    if (event_types.CHAT_CHANGED) eventSource.on(event_types.CHAT_CHANGED, () => { warnedPaths.clear(); settleAwaitedBox(); });
}
