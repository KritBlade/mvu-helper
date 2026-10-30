// sillytavern/chat-reload.js — the ONE place that reloads the chat, and the scope that makes an
// operation pay for it once. Host I/O only; the scope bookkeeping is pure in chat-reload-core.js, which
// also records WHY a reload is the mechanism (SillyTavern applies nothing to already-rendered messages).
//
// Two kinds of caller:
//   • a WRITER that changed something rendered — regexes (tavern-regex.js), a StatusMenu layout or its
//     engine text — calls requestChatReload(reason);
//   • a BULK operation — the dev loop applying every artifact in a workspace, or one activation writing
//     layout + engine + regexes — wraps itself in withChatReloadsCoalesced so the requests inside it
//     collapse into a single reload when it settles. Scopes nest; the outermost one reloads.
// A writer that changed NOTHING must not call at all: silence is what makes a re-apply of an unchanged
// artifact free, and it is the caller — which alone knows whether a byte differed — that decides.

import { createModuleLog } from './log.js';
import { getCurrentChatId, reloadCurrentChat } from '../../../../../../script.js';
import { createReloadCoalescer } from './chat-reload-core.js';

const log = createModuleLog('chat-reload');

const reloadCoalescer = createReloadCoalescer();

// Ask for the rendered chat to catch up with what was just written. Reloads now when no bulk scope is
// open; inside one, it is counted and the scope reloads once. `reason` names the writer and what changed
// — it is the only line that says why a reload happened, so it is logged either way.
export async function requestChatReload(reason) {
    const why = String(reason || 'content changed');
    if (!reloadCoalescer.request()) {
        log.lifecycle('deferred — ' + why + ' (a bulk operation is open and reloads ONCE when it closes)');
        return false;
    }
    log.lifecycle('reloading the chat — ' + why);
    await reloadChatNow();
    return true;
}

// ONE chat reload for a whole bulk operation. Everything `fn` does that would ask for a reload is
// collected, and the chat reloads once after `fn` settles — or not at all when nothing asked.
export async function withChatReloadsCoalesced(fn) {
    reloadCoalescer.begin();
    try {
        return await fn();
    } finally {
        const closed = reloadCoalescer.end();
        if (closed.reload) {
            log.lifecycle('reloading ONCE for the bulk operation (' + closed.coalesced + ' request(s) coalesced)');
            await reloadChatNow();
        }
    }
}

async function reloadChatNow() {
    if (!getCurrentChatId()) return;   // nothing rendered to refresh, and no chat to reload
    try {
        await reloadCurrentChat();
    } catch (e) {
        log.warn('the chat reload failed — what was written is CORRECT on the card, but the '
            + 'rendered messages and the regex list stay stale until the next reload:', e);
    }
}
