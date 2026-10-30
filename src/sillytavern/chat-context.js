// sillytavern/chat-context.js — SillyTavern's live context (the chat array and what hangs off it), read
// through the global the page exposes. Read fresh on every call: the chat is replaced on every chat load.
//
// `null` when the page has no context yet. A throw is reported under the caller's own prefix and
// answered with `null`, so every caller already handles it as "no chat to read".
import { createModuleLog } from './log.js';

const log = createModuleLog('chat-context');

export function chatContext(caller) {
    try { return (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null; }
    catch (e) { log.warn('[' + caller + '] could not read SillyTavern context:', e); return null; }
}

// The open chat's messages, the live array; [] when there is no context or no chat.
export function chatMessages(caller) {
    const context = chatContext(caller);
    return context && Array.isArray(context.chat) ? context.chat : [];
}
