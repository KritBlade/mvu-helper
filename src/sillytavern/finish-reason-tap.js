// sillytavern/finish-reason-tap.js — OBSERVE the finish reason SillyTavern throws away.
//
// ST 1.18 discards `finish_reason` at every layer: the client parses the SSE/json and never reads
// the field (zero occurrences in public/), so `msg.extra.finish_reason` — the field
// reply-integrity-core was built to consume — is written by NOTHING, and a provider content-filter
// kill on the MAIN reply is indistinguishable from a dropped stream ("cause UNKNOWN").
//
// ⚠ DOCTRINE EXCEPTION, decided by the user 2026-08-31. reply-integrity-core's first version ruled
// that reading the wire ourselves is "one component covering for another's flaw" and the only
// correct fix is upstream. The user overrode it: Gemini filter-kills are frequent, the cause label
// matters every time, and upstream has no timeline. Scope of the exception: this module OBSERVES
// only — it clones responses, never alters a request, a response, or their timing, and it dies the
// moment upstream surfaces the field (delete this file, keep the consumers).
//
// WHAT IT DOES: wraps window.fetch once. For ST's completion endpoints it clones the response and
// extracts the finish reason (json body or SSE stream — the clone's .text() resolves when the
// stream completes, so nothing here waits on it). The result lands in a one-slot store that
// reply-integrity consumes on MESSAGE_RECEIVED (consume-once + freshness window, so a small-LLM
// call's finish can never be read as the NEXT reply's). It also writes the raw reason onto
// `msg.extra.finish_reason` — the mutation is IN PLACE on the live message object, never via
// setChatMessages with an `extra` payload (that clobbers every other swipe's extra).
//
// It deliberately does NOT warn here: the small-LLM path already warns per call (runLlmCall), and
// the main reply's warn belongs to reply-integrity, which owns the player-facing wording. One
// verbose line per observed cut is the only output, so the tap can be watched without being noisy.
import { createModuleLog } from './log.js';
import { completionFinishReason, completionCutReason, sseFinishReason, looksLikeSseBody } from '../shared/completion-finish.js';

const log = createModuleLog('finish-reason-tap');

// The endpoints worth observing — ST's two completion backends. Kobold/novel report no finish
// reason worth reading, and everything else on the page is none of our business.
export function isCompletionEndpoint(url) {
    const u = String(url || '');
    return u.includes('/api/backends/chat-completions/generate')
        || u.includes('/api/backends/text-completions/generate');
}

// One slot, newest wins. `consumed` keeps a small-LLM call that finished AFTER the main reply from
// being read as the reply's own reason a minute later on the next MESSAGE_RECEIVED.
let latest = null;   // { reason, display, at, consumed }

const FRESH_MS = 30000;

// The most recent finish reason, if it is fresh and unconsumed — reply-integrity's read.
// Consuming is what keeps one observation from labelling two replies.
export function takeRecentFinishReason(now = Date.now()) {
    if (!latest || latest.consumed || (now - latest.at) > FRESH_MS) return null;
    latest.consumed = true;
    return { reason: latest.reason, display: latest.display };
}

function record(reason, display, url) {
    if (!reason) return;
    latest = { reason, display, at: Date.now(), consumed: false };
    if (display) log.verbose(`provider CUT observed on ${String(url).replace(/^.*\/api\//, '/api/')}: "${display}"`);
}

// EXPORTED for the wire-once guard only.
let wired = false;

export function wireFinishReasonTap() {
    if (wired || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
    wired = true;
    const origFetch = window.fetch;
    window.fetch = function (input, _init) {
        const result = origFetch.apply(this, arguments);
        try {
            const url = (typeof input === 'string') ? input : (input && input.url) || '';
            if (isCompletionEndpoint(url)) {
                result.then((res) => {
                    try {
                        if (!res || !res.ok || typeof res.clone !== 'function') return;
                        const clone = res.clone();
                        // ONE read, then branch on the BODY — never on content-type. Both arms need the
                        // text anyway, and for a stream .text() resolves when the provider closes it, so
                        // nothing here waits on the hot path. See looksLikeSseBody for why the header
                        // cannot be trusted: a provider or relay that streams SSE under some other
                        // content-type sent every streamed reply down the JSON arm, where it threw and
                        // the observation was skipped — on exactly the replies a stream DROP has to be
                        // told apart from a filter kill.
                        clone.text().then((body) => {
                            if (looksLikeSseBody(body)) {
                                const { reason, display } = sseFinishReason(body);
                                record(reason, display, url);
                                return;
                            }
                            let json;
                            try { json = JSON.parse(body); }
                            catch (e) { log.verbose('body is neither SSE nor JSON (observation skipped):', e); return; }
                            record(completionFinishReason(json), completionCutReason(json), url);
                        }).catch((e) => log.verbose('response clone unreadable (observation skipped):', e));
                    } catch (e) { log.warn('observation failed (the generation itself is untouched):', e); }
                }, () => { /* EXPECTED: the fetch rejected — the caller handles it, nothing to observe */ });
            }
        } catch (e) { log.warn('tap error (the generation itself is untouched):', e); }
        return result;
    };
    log.lifecycle('tap armed — observing completion endpoints for the finish reason ST drops');
}
