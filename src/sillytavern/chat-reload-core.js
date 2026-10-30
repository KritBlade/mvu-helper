// sillytavern/chat-reload-core.js — PURE bookkeeping for "reload the chat once per operation" (zero
// imports, zero globals, so it loads under vitest). The reload itself is host I/O and lives in
// sillytavern/chat-reload.js — the L6 split: a decision that lives only inside a host-coupled function
// is a decision no test can reach.
//
// WHY A CHAT RELOAD IS THE MECHANISM AT ALL (measured live 2026-08-28, SillyTavern 1.13.x):
// SillyTavern does NOT apply changed content to messages already on screen. Display regexes run at
// RENDER time, so a regex pushed into settings changes nothing until something re-renders; a StatusMenu
// frame reads its layout from the lorebook ONCE, at its own init. SillyTavern's own regex editor agrees —
// saveRegexScript ends in loadRegexScripts() then reloadCurrentChat() (regex/index.js:557). The cheaper
// path exists (updateMessageBlock + emit MESSAGE_UPDATED rebuilds one message and its TavernHelper
// iframe) and is deliberately NOT taken: MESSAGE_UPDATED is listened to by JS-Slash-Runner,
// ST-Prompt-Template, mvu-helper itself and more, so firing it to redraw would run every one of those
// passes for a redraw's sake. Copy the host's workflow: reload.
//
// WHAT THIS FILE ADDS: an operation that changes several things must still reload ONCE. Requests made
// inside an open scope are counted, not served, and the scope's close reports whether to reload.
//   begin()   opens a scope (nests)                request() → true = reload NOW (no scope open);
//   end()     → { reload: boolean, coalesced: n }   false = deferred, and one request is remembered.
export function createReloadCoalescer() {
    let depth = 0;
    let coalesced = 0;
    return {
        begin() { depth++; },
        request() {
            if (depth <= 0) return true;
            coalesced++;
            return false;
        },
        end() {
            depth = Math.max(0, depth - 1);
            if (depth > 0) return { reload: false, coalesced: 0 };
            const n = coalesced;
            coalesced = 0;
            return { reload: n > 0, coalesced: n };
        },
        isOpen() { return depth > 0; },
    };
}
