// shared/completion-finish.js — WHY did a completion stop? Pure parsing of provider finish reasons,
// shared because two independent consumers read the same wire shapes: the small-LLM call path
// (features/small-llm, its own raw response in hand) and the finish-reason tap on the MAIN
// generation (sillytavern/finish-reason-tap.js, observing a cloned response). No host imports.

// Finishes that mean "the model was DONE" — everything else means the output was cut or odd enough
// to surface. Tool-call handoffs end a turn on purpose and are not cuts.
export const COMPLETION_NORMAL_FINISHES = new Set(['stop', 'end_turn', 'tool_calls', 'function_call']);

// The raw finish reason from a completion response body, '' when the shape holds none.
// Arms: OpenAI-style chat/text completions (`choices[0].finish_reason`) and Google's native shape
// (`candidates[0].finishReason` — the direct makersuite path, where a safety kill says 'SAFETY').
export function completionFinishReason(data) {
    if (!data || typeof data !== 'object') return '';
    const choice = data.choices && data.choices[0];
    if (choice && choice.finish_reason != null) return String(choice.finish_reason).trim();
    const candidate = data.candidates && data.candidates[0];
    if (candidate && candidate.finishReason != null) return String(candidate.finishReason).trim();
    return '';
}

// Why a completion STOPPED, when that reason means the output was CUT — '' for a normal finish.
// The live miss this exists for (2026-08-31, ArtificKoi + School + standalone-probe): a POST call's
// output died at 313 chars on `finish_reason: "content_filter"` — the first contract's block got
// out, and every contract later in the shared output was never generated, while the pipeline log
// said only `POST 1 block(s) → writing`. A provider cut must never read like a model declining.
// The provider's native detail (OpenRouter's `native_finish_reason`) is appended when it adds
// something the primary word does not.
export function completionCutReason(data) {
    const reason = completionFinishReason(data);
    if (!reason || COMPLETION_NORMAL_FINISHES.has(reason.toLowerCase())) return '';
    const choice = data.choices && data.choices[0];
    const native = String((choice && choice.native_finish_reason) || '').trim();
    return native && native.toLowerCase() !== reason.toLowerCase() ? reason + ' (native: ' + native + ')' : reason;
}
// Is this response body an SSE STREAM rather than a JSON document?
//
// DECIDED BY THE BODY, NEVER BY content-type. The tap used to branch on a
// `content-type: text/event-stream` header, and a provider (or a relay in front of one) can stream
// SSE under some other content-type — the body then went down the JSON arm, where `data: {"id"…` is
// not valid JSON, and the observation was SKIPPED on every streamed reply. That is exactly the case
// the observation exists for: a streamed reply is where a relay DROP has to be told apart from a
// provider filter kill. Measured live 2026-09-19: `Unexpected token 'd', "data: {"id"…`.
//
// The FIRST non-empty line settles it and nothing further is read: an SSE body opens with a field
// line (`data:`, `event:`, `retry:`) or a `:` comment, and a JSON document opens with `{` or `[`.
// Bounded to the head of the body so a megabyte of stream is never scanned to answer it.
export function looksLikeSseBody(body) {
    for (const line of String(body || '').slice(0, 4096).split('\n')) {
        const t = line.trim();
        if (!t) continue;
        return t.startsWith('data:') || t.startsWith('event:') || t.startsWith('retry:') || t.startsWith(':');
    }
    return false;
}


// The finish reason out of a STREAMED (SSE) completion body: the LAST parseable `data: {...}` chunk
// that carries one wins, because providers send it on the final delta. Unparseable lines and
// `[DONE]` markers are skipped — they carry no reason and failing on them would erase a reason an
// earlier chunk already delivered.
export function sseFinishReason(sseText) {
    let reason = '';
    let native = '';
    for (const line of String(sseText || '').split('\n')) {
        const m = /^data:\s*(\{[\s\S]*\})\s*$/.exec(line);
        if (!m) continue;
        // EXPECTED throw: partial or non-JSON chunks are normal in an SSE body — skip, keep the last good reason.
        let chunk; try { chunk = JSON.parse(m[1]); } catch { continue; }
        const r = completionFinishReason(chunk);
        if (r) {
            reason = r;
            const choice = chunk.choices && chunk.choices[0];
            native = String((choice && choice.native_finish_reason) || '').trim();
        }
    }
    if (!reason) return { reason: '', display: '' };
    const cut = !COMPLETION_NORMAL_FINISHES.has(reason.toLowerCase());
    const display = !cut ? ''
        : (native && native.toLowerCase() !== reason.toLowerCase() ? reason + ' (native: ' + native + ')' : reason);
    return { reason, display };
}
