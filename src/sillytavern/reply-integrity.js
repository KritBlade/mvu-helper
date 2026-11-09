// sillytavern/reply-integrity.js — is the reply ST just finished actually INTACT?
//
// WHY IT EXISTS: a generation that dies partway leaves an `<UpdateVariable>` / `<JSONPatch>` block
// with no closing tag, and a narrator can write its block broken (a patch tag never closed, a body
// that will not parse) — either way every variable write that block was carrying is silently lost:
// MVU drops a patch it cannot read without a word. The prose still renders, and
// nothing anywhere says a turn's state changes went missing. A card's own GUI is where that hurts
// most: it reads the state, finds nothing new (or fails to parse the block itself) and renders an
// empty panel, so the player sees "nothing happened" rather than "this turn broke". The console
// carries a parse error, but nobody plays with the console open.
//
// THE SECOND DUTY: a reply that is not cut but carries no <UpdateVariable> block at all. On a plain
// card that is the normal quiet turn, so it is reported ONLY when an installed GameLogic Pack or
// Plugin promises a block in every reply (`requiresUpdateVariable`, rule 16). It runs once the cut
// verdict is in, so a reply gets one toast at most: a cut reply already says it saved nothing.
//
// WHY IT IS NOT IN A FEATURE FOLDER: nothing here is anyone's product behaviour. It reads two host
// fields — the message text and ST's finish reason — and reports damage. It knows nothing about any
// consumer's schema, and nothing about PRE/POST/narrate as ROLES; it only knows the MVU tag pair,
// which is mvu-helper's own vocabulary. Who promised a block is read through a source the composition
// root hands in (setUpdateVariableDeclarersSource), so this host module imports no feature. It also
// must not inherit any feature's gates: the FIRST version of this check sat inside the small-LLM POST
// pass, below three returns, so a card with no POST call configured would never have been told its
// writes were lost.
//
// The one gate it DOES keep is a stop: a user who aborts mid-stream has truncated the reply on
// purpose, and toasting that would be nagging about something they just did deliberately. Tracked
// here rather than borrowed, so this module owns every condition it acts on.
import { eventSource, event_types } from '../../../../../../script.js';
import { createModuleLog } from './log.js';
import {
    diagnoseTruncatedReply, explain, remedy, damage, damagePlain, headline, toastTitle,
    isGenerationReplyType, hasUpdateVariableBlock, missingUpdateVariableLog, missingUpdateVariableToast,
} from './reply-integrity-core.js';
import { takeRecentFinishReason } from './finish-reason-tap.js';
import { toast } from './mvu-bridge.js';

const log = createModuleLog('reply-integrity');

let generationStopped = false;

// How long the verdict waits for a streamed reply's finish reason when none was observed at MESSAGE_RECEIVED.
// The tap reads the stream's clone as it closes, which can settle just after the event.
const LATE_FINISH_REASON_WAIT_MS = 2000;

// Who promised an <UpdateVariable> block in every reply: pack-info's readUpdateVariableDeclarers, handed in
// at startup. Until then nothing promised one, which is also what a plain card answers.
let readUpdateVariableDeclarers = async () => [];
export function setUpdateVariableDeclarersSource(source) {
    if (typeof source === 'function') readUpdateVariableDeclarers = source;
    else log.warn('setUpdateVariableDeclarersSource needs a function — ignored:', source);
}

// The second duty. The text is the reply as the narrator finished it, read at MESSAGE_RECEIVED: later
// writers edit the message, and none of them supplies the narrator's block. The card is read only when the
// block is missing, so a healthy reply costs nothing.
async function warnIfPromisedBlockMissing(narratorText) {
    try {
        if (hasUpdateVariableBlock(narratorText)) return;
        const declarers = await readUpdateVariableDeclarers();
        if (!declarers.length) return;
        log.warn(missingUpdateVariableLog(declarers));
        if (typeof toastr !== 'undefined') {
            toast('warning', missingUpdateVariableToast(), 'MVU Helper — no state update', { timeOut: 10000 });
        }
    } catch (e) {
        log.warn('the missing-<UpdateVariable> check failed (non-fatal):', e);
    }
}

export function wireReplyIntegrity() {
    if (!eventSource || !event_types) return;
    if (event_types.GENERATION_STOPPED) eventSource.on(event_types.GENERATION_STOPPED, () => { generationStopped = true; });
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, (_type, _opts, dryRun) => { if (!dryRun) generationStopped = false; });
    }
    if (!event_types.MESSAGE_RECEIVED) return;
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, type) => {
        try {
            if (generationStopped) return;                 // the user aborted — truncation is what they asked for
            const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
            const chat = ctx && ctx.chat;
            if (!Array.isArray(chat)) return;
            const msg = chat[(messageId != null && chat[messageId]) ? Number(messageId) : chat.length - 1];
            if (!msg || msg.is_user) return;
            const narratorText = msg.mes;
            const checkPromisedBlock = () => {
                if (isGenerationReplyType(type)) void warnIfPromisedBlockMissing(narratorText);
            };
            // The tap observed this generation's finish reason (ST itself drops the field) — judge
            // consumes it once and stamps it onto the message IN PLACE, so `msg.extra.finish_reason`
            // finally holds what the provider said. Never via setChatMessages with an `extra`
            // payload: that clobbers every other swipe's extra.
            // It judges the narrator's text as it arrived: later writers append their own blocks to the message.
            const judge = (observed) => {
                if (observed && observed.reason) {
                    if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
                    if (msg.extra.finish_reason == null) msg.extra.finish_reason = observed.reason;
                }
                const cut = diagnoseTruncatedReply(narratorText,
                    (observed && (observed.display || observed.reason))
                    || (msg.extra && (msg.extra.finish_reason || msg.extra.finishReason)));
                if (!cut.truncated) return false;
                log.warn(`${headline(cut)} (${cut.defect}) — ${damage(cut)}. Cause: ${explain(cut)}`);
                // EXPECTED absent: toastr is not there in headless/test hosts — the warn above still fired.
                try {
                    if (typeof toastr !== 'undefined') {
                        toast('warning',
                            `${damagePlain(cut)} ${remedy(cut)} Swipe to retry.`,
                            toastTitle(cut), { timeOut: 10000 },
                        );
                    }
                } catch (_e) { /* EXPECTED: toastr absent */ }
                return true;
            };
            // ONE verdict, made once the finish reason is in. A streamed reply's reason can land after this
            // event; judging before it arrives names a reason that is merely LATE as missing, and the
            // "stream died" cause then points at the connection — live 2026-11-08 on a relay that reports
            // "stop" on every reply. So with nothing observed yet, the verdict waits for the late one.
            // The promised-block check follows the verdict, so a reply cut before its block gets the
            // cut-off toast alone.
            const decide = (observed) => { if (!judge(observed)) checkPromisedBlock(); };
            const observed = takeRecentFinishReason();
            if (observed) {
                decide(observed);
            } else {
                setTimeout(() => {
                    try { decide(takeRecentFinishReason()); }
                    catch (e) { log.warn('late finish-reason check failed (non-fatal):', e); }
                }, LATE_FINISH_REASON_WAIT_MS);
            }
        } catch (e) {
            log.warn('reply check failed (non-fatal):', e);
        }
    });
}
