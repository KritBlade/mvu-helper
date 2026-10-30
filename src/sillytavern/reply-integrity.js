// sillytavern/reply-integrity.js — is the reply ST just finished actually INTACT?
//
// WHY IT EXISTS: a generation that dies partway leaves an `<UpdateVariable>` / `<JSONPatch>` block
// with no closing tag, or a body that will not parse — so every variable write that reply was
// carrying is silently lost. The prose still renders, MVU applies whatever it could salvage, and
// nothing anywhere says a turn's state changes went missing. A card's own GUI is where that hurts
// most: it reads the state, finds nothing new (or fails to parse the block itself) and renders an
// empty panel, so the player sees "nothing happened" rather than "this turn broke". The console
// carries a parse error, but nobody plays with the console open.
//
// WHY IT IS NOT IN A FEATURE FOLDER: nothing here is anyone's product behaviour. It reads two host
// fields — the message text and ST's finish reason — and reports damage. It knows nothing about any
// consumer's schema, and nothing about PRE/POST/narrate as ROLES; it only knows the MVU tag pair,
// which is mvu-helper's own vocabulary. It also must not inherit any feature's gates: the FIRST
// version of this check sat inside the small-LLM POST pass, below three returns, so a card with no
// POST call configured would never have been told its writes were lost.
//
// The one gate it DOES keep is a stop: a user who aborts mid-stream has truncated the reply on
// purpose, and toasting that would be nagging about something they just did deliberately. Tracked
// here rather than borrowed, so this module owns every condition it acts on.
import { eventSource, event_types } from '../../../../../../script.js';
import { createModuleLog } from './log.js';
import { diagnoseTruncatedReply, explain, remedy, damage, damagePlain } from './reply-integrity-core.js';
import { takeRecentFinishReason } from './finish-reason-tap.js';
import { toast } from './mvu-bridge.js';

const log = createModuleLog('reply-integrity');

let generationStopped = false;

export function wireReplyIntegrity() {
    if (!eventSource || !event_types) return;
    if (event_types.GENERATION_STOPPED) eventSource.on(event_types.GENERATION_STOPPED, () => { generationStopped = true; });
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, (_type, _opts, dryRun) => { if (!dryRun) generationStopped = false; });
    }
    if (!event_types.MESSAGE_RECEIVED) return;
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
        try {
            if (generationStopped) return;                 // the user aborted — truncation is what they asked for
            const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
            const chat = ctx && ctx.chat;
            if (!Array.isArray(chat)) return;
            const msg = chat[(messageId != null && chat[messageId]) ? Number(messageId) : chat.length - 1];
            if (!msg || msg.is_user) return;
            // The tap observed this generation's finish reason (ST itself drops the field) —
            // consume it once and stamp it onto the message IN PLACE, so `msg.extra.finish_reason`
            // finally holds what the provider said. Never via setChatMessages with an `extra`
            // payload: that clobbers every other swipe's extra.
            //
            // A STREAMED reply races this event: the tap reads its clone's SSE text only when the
            // stream closes, which can resolve AFTER MESSAGE_RECEIVED — so when nothing has been
            // observed yet, ONE delayed retry consumes the late observation. Without it the tap
            // misses exactly the streaming mains it was built for (live 2026-08-31: a clean turn's
            // stamp arrived null). The retry only ADDS: it stamps, and it warns only if the reason
            // reveals a cut the shape pass could not see — a reply already reported stays reported.
            const judge = (observed) => {
                if (observed && observed.reason) {
                    if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
                    if (msg.extra.finish_reason == null) msg.extra.finish_reason = observed.reason;
                }
                const cut = diagnoseTruncatedReply(msg.mes,
                    (observed && (observed.display || observed.reason))
                    || (msg.extra && (msg.extra.finish_reason || msg.extra.finishReason)));
                if (!cut.truncated) return false;
                log.warn(`the reply is TRUNCATED (${cut.defect}) — ${damage(cut)}. Cause: ${explain(cut)}`);
                // EXPECTED absent: toastr is not there in headless/test hosts — the warn above still fired.
                try {
                    if (typeof toastr !== 'undefined') {
                        toast('warning', 
                            `${damagePlain(cut)} ${remedy(cut)} Swipe to retry.`,
                            'MVU Helper — reply cut off', { timeOut: 10000 },
                        );
                    }
                } catch (_e) { /* EXPECTED: toastr absent */ }
                return true;
            };
            const observed = takeRecentFinishReason();
            const reported = judge(observed);
            if (!observed && !reported) {
                setTimeout(() => {
                    try { judge(takeRecentFinishReason()); }
                    catch (e) { log.warn('late finish-reason check failed (non-fatal):', e); }
                }, 2000);
            }
        } catch (e) {
            log.warn('reply check failed (non-fatal):', e);
        }
    });
}
