// tests/call-input-macros-core.test.js — the {{mvuhelper::…}} read surface
// (plans/call-input-macros-plan.md P1).
//
// Everything decision-shaped lives in call-input-macros-core.js and is proven here. The wiring
// (where each context comes from, substitution order, the lint) is in extra-llm-calls.js and is
// exercised live.
//
// The contract these tests defend, in one line: a card author must never be able to make a call
// THROW. Every malformed/absent/unresolvable case resolves to '' and reports a warn — because the
// alternative is an EJS-level failure, which ships the whole block to the model as raw text that
// still reads like prose.

import { describe, it, expect } from 'vitest';
import {
    blockUsesInputMacros,
    collectAssistantHistory,
    formatHistory,
    findCallOutput,
    resolveInputMacro,
    substituteInputMacros,
    formatMacroTrace,
    findSwipeUnsafeMacros,
} from '../src/features/small-llm/call-input-macros-core.js';

const strip = (s) => String(s == null ? '' : s).replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '').trim();

// A coreChat-shaped array: user/assistant alternating, one reply carrying a UV block.
const CHAT = [
    { is_user: true, mes: 'hello' },
    { is_user: false, mes: 'reply one<UpdateVariable>{"ops":[]}</UpdateVariable>' },
    { is_user: true, mes: 'second line' },
    { is_user: false, mes: 'reply two' },
    { is_user: true, mes: 'third line' },
    { is_user: false, mes: 'reply three' },
];

describe('blockUsesInputMacros / substituteInputMacros — the grammar', () => {
    // The tokens substitution resolved, in source order — what the pipeline trace prints.
    const tokensIn = (text) => substituteInputMacros(text, {}).resolved.map(({ token, arg }) => ({ token, arg }));

    it('detects the namespace and ignores unrelated macros', () => {
        expect(blockUsesInputMacros('a {{mvuhelper::history}} b')).toBe(true);
        expect(blockUsesInputMacros('{{user}} {{lastCharMessage}}')).toBe(false);
        expect(blockUsesInputMacros('')).toBe(false);
        expect(blockUsesInputMacros(null)).toBe(false);
    });
    it('is case-insensitive on namespace + token, and tolerates inner whitespace', () => {
        expect(tokensIn('{{MvuHelper::History}} {{ mvuhelper :: userLine }}').map((f) => f.token)).toEqual(['history', 'userline']);
    });
    it('captures the ::arg, preserving its case for a call name', () => {
        expect(tokensIn('{{mvuhelper::callOutput::PRE2}}')[0]).toEqual({ token: 'calloutput', arg: 'PRE2' });
        expect(tokensIn('{{mvuhelper::history::3}}')[0]).toEqual({ token: 'history', arg: '3' });
    });
    it('is stateless across calls (a shared /g regex must not carry lastIndex)', () => {
        const text = '{{mvuhelper::history}}';
        expect(blockUsesInputMacros(text)).toBe(true);
        expect(blockUsesInputMacros(text)).toBe(true);   // would fail if lastIndex leaked
        expect(tokensIn(text)).toHaveLength(1);
        expect(tokensIn(text)).toHaveLength(1);
    });
});

describe('collectAssistantHistory — assistant replies, oldest→newest, UV stripped', () => {
    it('returns the newest N in oldest→newest order', () => {
        expect(collectAssistantHistory(CHAT, 2, { cleanReplyText: strip }))
            .toEqual(['reply two', 'reply three']);
    });
    it('strips <UpdateVariable> — a sim never wants patch blocks', () => {
        const all = collectAssistantHistory(CHAT, 3, { cleanReplyText: strip });
        expect(all[0]).toBe('reply one');
        expect(all.join()).not.toContain('UpdateVariable');
    });
    it('skips user and system messages, by flag OR role', () => {
        const mixed = [
            { role: 'system', mes: 'sys' },
            { is_system: true, mes: 'hidden' },
            { role: 'user', mes: 'u' },
            { role: 'assistant', mes: 'a' },
        ];
        expect(collectAssistantHistory(mixed, 5, { cleanReplyText: strip })).toEqual(['a']);
    });
    it('endExclusive bounds the walk — POST must not re-feed the reply it is already reading', () => {
        // mesId = 5 (the newest reply) → history sees replies BEFORE it only.
        expect(collectAssistantHistory(CHAT, 2, { endExclusive: 5, cleanReplyText: strip }))
            .toEqual(['reply one', 'reply two']);
    });
    it('a reply that strips to nothing is not a turn', () => {
        const onlyUv = [{ is_user: false, mes: '<UpdateVariable>{"ops":[]}</UpdateVariable>' }, { is_user: false, mes: 'real' }];
        expect(collectAssistantHistory(onlyUv, 5, { cleanReplyText: strip })).toEqual(['real']);
    });
    it('degrades to [] on junk input, never throws', () => {
        expect(collectAssistantHistory(null, 2)).toEqual([]);
        expect(collectAssistantHistory(CHAT, 0)).toEqual([]);
        expect(collectAssistantHistory(CHAT, -1)).toEqual([]);
    });
});

describe('formatHistory — headers only when they disambiguate', () => {
    it('one reply → bare text (the common case should read like prose)', () => {
        expect(formatHistory(['solo'])).toBe('solo');
    });
    it('several → numbered oldest→newest, -1 is the most recent', () => {
        const out = formatHistory(['older', 'newer']);
        expect(out).toContain('--- reply -2 ---\nolder');
        expect(out).toContain('--- reply -1 ---\nnewer');
        expect(out.indexOf('older')).toBeLessThan(out.indexOf('newer'));
    });
    it('empty → empty string', () => {
        expect(formatHistory([])).toBe('');
        expect(formatHistory(null)).toBe('');
    });
});

describe('findCallOutput', () => {
    const outputs = [{ name: 'PRE', output: '{"check":1}' }, { name: 'PRE2', output: '<JSONPatch>[]</JSONPatch>' }];
    it('matches by name, case-insensitively', () => {
        expect(findCallOutput(outputs, 'PRE2')).toBe('<JSONPatch>[]</JSONPatch>');
        expect(findCallOutput(outputs, 'pre2')).toBe('<JSONPatch>[]</JSONPatch>');
    });
    it('absent / null-output / junk → empty string, never throws', () => {
        expect(findCallOutput(outputs, 'PRE9')).toBe('');
        expect(findCallOutput([{ name: 'X', output: null }], 'X')).toBe('');
        expect(findCallOutput(null, 'PRE')).toBe('');
        expect(findCallOutput(outputs, '')).toBe('');
    });
});

describe('resolveInputMacro — per-token semantics', () => {
    const preCtx = { stage: 'pre', chat: CHAT, userLine: 'third line', cleanReplyText: strip };
    const postCtx = {
        stage: 'post', chat: CHAT, userLine: 'third line', historyEndExclusive: 5, cleanReplyText: strip,
        callOutputs: [{ name: 'PRE2', output: 'sim brief' }],
    };

    it('history with no arg = history::1', () => {
        expect(resolveInputMacro({ token: 'history', arg: '' }, preCtx).value).toBe('reply three');
    });
    it('history::N collects N', () => {
        expect(resolveInputMacro({ token: 'history', arg: '2' }, preCtx).value).toContain('reply two');
    });
    it('history::junk → empty + a warn naming the bad arg (never throws)', () => {
        const r = resolveInputMacro({ token: 'history', arg: 'abc' }, preCtx);
        expect(r.value).toBe('');
        expect(r.warn).toMatch(/not a positive whole number/);
    });
    it('history::N is capped so a typo cannot dump the whole chat', () => {
        const big = resolveInputMacro({ token: 'history', arg: '9999' }, preCtx);
        expect(big.warn).toBe('');
        expect(big.value.match(/--- reply -/g) || []).toHaveLength(3);   // only 3 replies exist
    });
    it('userLine returns the line, empty-tolerant', () => {
        expect(resolveInputMacro({ token: 'userline', arg: '' }, preCtx).value).toBe('third line');
        expect(resolveInputMacro({ token: 'userline', arg: '' }, {}).value).toBe('');
    });

    // The ordering constraint, enforced rather than documented: PRE calls run in PARALLEL.
    it('callOutput in a PRE block → empty + a warn explaining POST-only', () => {
        const r = resolveInputMacro({ token: 'calloutput', arg: 'PRE2' }, preCtx);
        expect(r.value).toBe('');
        expect(r.warn).toMatch(/POST-only/);
        expect(r.warn).toMatch(/PARALLEL/);
    });
    it('callOutput in a POST block resolves this turn\'s output', () => {
        expect(resolveInputMacro({ token: 'calloutput', arg: 'PRE2' }, postCtx).value).toBe('sim brief');
    });
    it('callOutput with no name → empty + a warn showing the correct form', () => {
        const r = resolveInputMacro({ token: 'calloutput', arg: '' }, postCtx);
        expect(r.value).toBe('');
        expect(r.warn).toMatch(/callOutput::PRE2/);
    });
    it('callOutput naming a call that produced nothing → empty + a warn listing the causes', () => {
        const r = resolveInputMacro({ token: 'calloutput', arg: 'GHOST' }, postCtx);
        expect(r.value).toBe('');
        expect(r.warn).toMatch(/disabled \/ failed \/ not configured/);
    });
    // A routed task's per-turn instruction (llm-task-router taskInstructionToken). The pass resolves every
    // task's text before its calls run, so this is a lookup in the context, in PRE and POST alike.
    it('task resolves a routed task\'s instruction for this turn, in PRE and POST', () => {
        const withTask = (ctx) => ({ ...ctx, taskInstructions: { 'reg': 'register Wren' } });
        expect(resolveInputMacro({ token: 'task', arg: 'reg' }, withTask(postCtx))).toEqual({ value: 'register Wren', warn: '' });
        expect(resolveInputMacro({ token: 'task', arg: 'reg' }, withTask(preCtx)).value).toBe('register Wren');
    });
    // MUTATION TARGET: resolve a missing task silently and an empty registration reads as "nothing to do".
    it('task naming no routed task → empty + a warn saying so', () => {
        const r = resolveInputMacro({ token: 'task', arg: 'ghost' }, postCtx);
        expect(r.value).toBe('');
        expect(r.warn).toMatch(/no active task "ghost"/);
    });
    it('task with no id → empty + a warn showing the form', () => {
        const r = resolveInputMacro({ token: 'task', arg: '' }, postCtx);
        expect(r.value).toBe('');
        expect(r.warn).toMatch(/needs a task id/);
    });
    it('an unknown token → empty + a warn LISTING the known ones (a silent unknown reads as empty history — a lie)', () => {
        const r = resolveInputMacro({ token: 'histry', arg: '' }, preCtx);
        expect(r.value).toBe('');
        expect(r.warn).toMatch(/not a known token/);
        expect(r.warn).toMatch(/history/);
    });
});

describe('substituteInputMacros — the whole pass', () => {
    const ctx = { stage: 'pre', chat: CHAT, userLine: 'third line', cleanReplyText: strip };

    it('replaces every occurrence and reports each in source order', () => {
        const { text, resolved } = substituteInputMacros('A {{mvuhelper::userLine}} B {{mvuhelper::history}} C', ctx);
        expect(text).toBe('A third line B reply three C');
        expect(resolved.map((r) => r.token)).toEqual(['userline', 'history']);
    });
    it('an unresolvable token leaves the surrounding block INTACT — the call still runs', () => {
        const { text, warns } = substituteInputMacros('keep {{mvuhelper::nope}} this', ctx);
        expect(text).toBe('keep  this');
        expect(warns).toHaveLength(1);
    });
    it('never re-interprets what it inserted: EJS/macro syntax inside a reply passes through as TEXT', () => {
        const hostile = [{ is_user: false, mes: 'she said <% danger %> and {{user}} blinked' }];
        const { text } = substituteInputMacros('{{mvuhelper::history}}', { ...ctx, chat: hostile });
        expect(text).toBe('she said <% danger %> and {{user}} blinked');
    });
    it('no macros → the text is returned untouched, nothing reported', () => {
        const { text, resolved, warns } = substituteInputMacros('plain block', ctx);
        expect(text).toBe('plain block');
        expect(resolved).toEqual([]);
        expect(warns).toEqual([]);
    });
    it('junk input degrades instead of throwing', () => {
        expect(substituteInputMacros(null, ctx).text).toBe('');
        expect(substituteInputMacros('{{mvuhelper::history}}', null).text).toBe('');
    });
});

describe('formatMacroTrace — log-sanity: an EMPTY resolution must still print', () => {
    it('prints ∅ for empty, length for resolved', () => {
        const line = formatMacroTrace([
            { token: 'history', arg: '2', length: 1840 },
            { token: 'calloutput', arg: 'PRE2', length: 0 },
        ]);
        expect(line).toBe('history::2=1840ch calloutput::PRE2=∅');
    });
    it('no tokens → no line (the caller prints nothing rather than an empty label)', () => {
        expect(formatMacroTrace([])).toBe('');
    });
});

describe('findSwipeUnsafeMacros — the lint', () => {
    it('flags ST chat macros and names the replacement', () => {
        const hits = findSwipeUnsafeMacros('ctx: {{lastCharMessage}} and {{lastUserMessage}}');
        expect(hits.map((h) => h.macro)).toEqual(['{{lastCharMessage}}', '{{lastUserMessage}}']);
        expect(hits[0].use).toBe('{{mvuhelper::history}}');
    });
    it('quiet on a clean block', () => {
        expect(findSwipeUnsafeMacros('{{mvuhelper::history}} {{user}}')).toEqual([]);
        expect(findSwipeUnsafeMacros(null)).toEqual([]);
    });
});
