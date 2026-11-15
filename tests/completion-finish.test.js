// shared/completion-finish.js — the finish-reason parses both completion consumers share.
import { describe, it, expect } from 'vitest';
import { completionFinishReason, completionCutReason, sseFinishReason, looksLikeSseBody } from '../src/shared/completion-finish.js';

describe('completionFinishReason', () => {
    it('reads the OpenAI choice arm and the Google candidates arm', () => {
        expect(completionFinishReason({ choices: [{ finish_reason: 'stop' }] })).toBe('stop');
        expect(completionFinishReason({ candidates: [{ finishReason: 'SAFETY' }] })).toBe('SAFETY');
        expect(completionFinishReason({})).toBe('');
        expect(completionFinishReason('a string')).toBe('');
        expect(completionFinishReason(null)).toBe('');
    });
    it('reads Ollama\'s and Cohere\'s own replies, which ST hands back as the provider sent them', () => {
        expect(completionFinishReason({ model: 'm', response: 'text', done: true, done_reason: 'length' })).toBe('length');
        expect(completionFinishReason({ finish_reason: 'MAX_TOKENS', message: { content: [{ type: 'text', text: 'x' }] } })).toBe('MAX_TOKENS');
    });
    it('reads the streamed event that ends a Claude or a Cohere message', () => {
        expect(completionFinishReason({ type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null } })).toBe('max_tokens');
        expect(completionFinishReason({ type: 'message-end', delta: { finish_reason: 'COMPLETE' } })).toBe('COMPLETE');
        // the events that carry text, not the end, hold no reason
        expect(completionFinishReason({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })).toBe('');
        expect(completionFinishReason({ type: 'content-delta', delta: { message: { content: { text: 'hi' } } } })).toBe('');
    });
    it('a non-streamed direct Claude reply holds no reason: ST\'s rebuild leaves stop_reason out', () => {
        expect(completionFinishReason({ choices: [{ message: { content: 'x' } }], content: [{ type: 'text', text: 'x' }] })).toBe('');
    });
});

describe('completionCutReason', () => {
    // MUTATION TARGET — the live 2026-08-31 provider cut (POST killed at 313 chars). Break the
    // normal-finish gate (report everything) and the 'stop' expectation fails; break the reporting
    // (always '') and the content_filter expectation fails.
    it('names a cut with the native detail when it adds something', () => {
        expect(completionCutReason({ choices: [{ finish_reason: 'content_filter', native_finish_reason: 'PROHIBITED_CONTENT' }] }))
            .toBe('content_filter (native: PROHIBITED_CONTENT)');
        expect(completionCutReason({ choices: [{ finish_reason: 'length' }] })).toBe('length');
        expect(completionCutReason({ candidates: [{ finishReason: 'SAFETY' }] })).toBe('SAFETY');
    });
    it('stays silent on normal finishes and unreadable shapes', () => {
        expect(completionCutReason({ choices: [{ finish_reason: 'stop' }] })).toBe('');
        expect(completionCutReason({ choices: [{ finish_reason: 'STOP', native_finish_reason: 'STOP' }] })).toBe('');
        expect(completionCutReason({ choices: [{ finish_reason: 'tool_calls' }] })).toBe('');
        expect(completionCutReason({ choices: [{}] })).toBe('');
        expect(completionCutReason(null)).toBe('');
    });
    it('names a cut on the token limit in Ollama\'s and Cohere\'s words', () => {
        expect(completionCutReason({ response: 'x', done: true, done_reason: 'length' })).toBe('length');
        expect(completionCutReason({ finish_reason: 'MAX_TOKENS', message: {} })).toBe('MAX_TOKENS');
    });
    it('stays silent on Ollama\'s, Cohere\'s and Claude\'s normal finishes and tool handoffs', () => {
        expect(completionCutReason({ response: 'x', done: true, done_reason: 'stop' })).toBe('');
        for (const reason of ['COMPLETE', 'STOP_SEQUENCE', 'TOOL_CALL']) {
            expect(completionCutReason({ finish_reason: reason, message: {} })).toBe('');
        }
        for (const reason of ['end_turn', 'stop_sequence', 'tool_use']) {
            expect(completionCutReason({ type: 'message_delta', delta: { stop_reason: reason } })).toBe('');
        }
    });
});

describe('sseFinishReason', () => {
    it('takes the LAST chunk carrying a reason, skipping [DONE] and noise', () => {
        const sse = [
            'data: {"choices":[{"delta":{"content":"hel"}}]}',
            'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"content_filter","native_finish_reason":"PROHIBITED_CONTENT"}]}',
            'data: [DONE]',
            '',
        ].join('\n');
        expect(sseFinishReason(sse)).toEqual({ reason: 'content_filter', display: 'content_filter (native: PROHIBITED_CONTENT)' });
    });
    it('a clean stop yields the reason but an empty display', () => {
        const sse = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\ndata: [DONE]';
        expect(sseFinishReason(sse)).toEqual({ reason: 'stop', display: '' });
    });
    it('reads a streamed Claude reply\'s message_delta and a streamed Cohere reply\'s message-end', () => {
        const claude = [
            'event: content_block_delta',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hel"}}',
            'event: message_delta',
            'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":512}}',
            'event: message_stop',
            'data: {"type":"message_stop"}',
        ].join('\n');
        expect(sseFinishReason(claude)).toEqual({ reason: 'max_tokens', display: 'max_tokens' });
        const cohere = [
            'event: content-delta',
            'data: {"type":"content-delta","index":0,"delta":{"message":{"content":{"text":"hi"}}}}',
            'event: message-end',
            'data: {"type":"message-end","delta":{"finish_reason":"COMPLETE","usage":{}}}',
        ].join('\n');
        expect(sseFinishReason(cohere)).toEqual({ reason: 'COMPLETE', display: '' });
    });
    it('no reason anywhere yields empties', () => {
        expect(sseFinishReason('data: {"choices":[{"delta":{"content":"x"}}]}')).toEqual({ reason: '', display: '' });
        expect(sseFinishReason('')).toEqual({ reason: '', display: '' });
        expect(sseFinishReason('not sse at all')).toEqual({ reason: '', display: '' });
    });
});

// ── which ARM the tap takes ─────────────────────────────────────────────────────────────────────
// THE INCIDENT (live 2026-09-19). finish-reason-tap branched on `content-type: text/event-stream`.
// The provider streamed SSE under some OTHER content-type, so the body went down the JSON arm and
// threw `Unexpected token 'd', "data: {"id"…` — every streamed reply was skipped, which is exactly
// the case the observation exists for: on a stream, a relay DROP has to be told apart from a
// provider filter kill. The decision lives here, in a pure file, because the tap wraps window.fetch
// and nothing inside it can be tested (L6).
describe('looksLikeSseBody — decide by the body, never by the header', () => {
    it('THE REGRESSION GUARD: an SSE body is recognised with no content-type in sight', () => {
        expect(looksLikeSseBody('data: {"id":"1","choices":[{"finish_reason":"stop"}]}\n\n')).toBe(true);
    });
    it('an SSE stream opening with event: or a : comment counts too', () => {
        expect(looksLikeSseBody('event: message\ndata: {"a":1}')).toBe(true);
        expect(looksLikeSseBody(': keep-alive\n\ndata: {"a":1}')).toBe(true);
        expect(looksLikeSseBody('retry: 3000\ndata: {"a":1}')).toBe(true);
    });
    it('a JSON document is NOT a stream — object or array, leading blank lines and all', () => {
        expect(looksLikeSseBody('{"choices":[{"finish_reason":"stop"}]}')).toBe(false);
        expect(looksLikeSseBody('\n\n   {"a":1}')).toBe(false);
        expect(looksLikeSseBody('[{"a":1}]')).toBe(false);
    });
    it('junk in, false — an unreadable body is not claimed to be a stream', () => {
        expect(looksLikeSseBody('')).toBe(false);
        expect(looksLikeSseBody(null)).toBe(false);
        expect(looksLikeSseBody(undefined)).toBe(false);
        expect(looksLikeSseBody('<html>error</html>')).toBe(false);
    });
    it('the FIRST non-empty line settles it, and only the head of the body is read', () => {
        // A megabyte of stream must never be scanned to answer a one-line question.
        const huge = 'data: {"a":1}\n' + 'x'.repeat(2_000_000);
        expect(looksLikeSseBody(huge)).toBe(true);
        // ...and a JSON document whose CONTENT mentions data: is still JSON.
        expect(looksLikeSseBody('{"note":"data: not a stream"}')).toBe(false);
    });
    it('the sniff and the parser agree: what it calls SSE, sseFinishReason can read', () => {
        const body = 'data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n';
        expect(looksLikeSseBody(body)).toBe(true);
        expect(sseFinishReason(body).reason).toBe('length');
    });
});
