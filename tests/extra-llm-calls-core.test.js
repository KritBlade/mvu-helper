/**
 * MVU Helper — Extra LLM Calls pure-core tests (small-llm/extra-llm-calls-core.js)
 *
 * Why this file exists: the real engine (small-llm/extraLlmCalls.js) directly imports the
 * SillyTavern host (`extensions.js`) and uses runtime globals (SillyTavern.getContext(),
 * getLorebookEntries, …) that only exist inside ST. None of that can load under
 * vitest. So all decision logic lives in extra-llm-calls-core.js — no host imports, no globals —
 * and is exercised here. extraLlmCalls.js is a thin I/O wrapper that delegates to these.
 *
 * This feature's CARD-CONFIG SECTION HANDLER lives there too but is tested with the rest of the
 * [Initmvuhelper] carry, in tests/card-config-core.test.js — that is where the ownership rules are.
 *
 * Coverage targets the bits most likely to silently break:
 *   - the `[name]` lorebook router (the boundary bug: "[llm2]" must NOT match "[llm22]")
 *   - coreChat shape handling (string / parts-array / mes) for read + inject
 *   - parallel vs sequential orchestration, and one bad call not sinking the batch
 *
 * Run:  npm test   (or:  npx vitest run --reporter=verbose)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TURN_AUDIT_TAG, REPLY_TAIL_ANCHORS } from '../src/features/logic-engine/turn-runner-core.js';
import { MENU_PLACEHOLDER } from '../src/features/statusmenu-pack/statusmenu-pack-core.js';
import { isTaskRoutingEntryName } from '../src/features/llm-task-router/llm-task-router-core.js';
import {
    placePostRelayBlock,
    loreEntryMatchesCall,
    selectLorebookBlock,
    selectCallSystemBlock,
    selectCallSystemManifest,
    extractTextContent,
    findLastUserIndex,
    findBaseFloorIndex,
    prependToMessage,
    buildMessages,
    readOocCommands,
    buildOocCommandBlock,
    oocCommandBlockFor,
    normalizeMaxTokens,
    buildOverridePayload,
    extractCompletionText, completionCutReason, describeNoTextAnswer,
    emptyResultCause, carriesOnlyTasks, sortEmptyResults, describeEmptyResult,
    enabledCalls,
    callRunBlocker,
    callPhase,
    enabledCallsForPhase,
    runCalls,
    callScheduleKey,
    postPhaseTimings,
    buildInjectionBlock,
    extractUpdateVariableBlocks,
    classifyPostOutput,
    checkCallOutput,
    stripUpdateVariableBlocks,
    stripPatchBlocks,
    toPostWrapper,
    renderEjsBlock,
    applyInputFilter,
    parseInputFilterRegex,
    parsePatchOps,
    readSameRoundPick,
    validateSimPatchOutput,
    preHookOutputs,
    postOpsRefused,
    simPreApplyDisposition,
    postTargetDisposition,
    splitSimOutput,
    splitAndCheckSimOutput,
    splitAndCheckPostOutput,
    decideOutputCheck,
    renderSimInjectLines,
    simSnapshotDisposition,
    recordSimUndo,
    restoreSimUndo,
    stepSimUndo,
    readSimUndoRecord,
    writeSimUndoRecord,
    SIM_UNDO_EXTRA_KEY,
    decideResCarry,
    isTurnSettledAtPostEnd,
    callDispatchDisposition, unrunnableRoutedCalls } from '../src/features/small-llm/extra-llm-calls-core.js';

// ── helpers ──────────────────────────────────────────────────────────────────
function entry(overrides = {}) {
    return { comment: '', keys: [], content: 'C', ...overrides };
}
function makeCall(overrides = {}) {
    return {
        id: 'call_1',
        name: 'llm2',
        profileId: 'prof_1',
        maxTokens: '',
        temperature: '',
        enabled: true,
        debug: false,
        ...overrides,
    };
}

// ── lorebook routing ─────────────────────────────────────────────────────────
describe('loreEntryMatchesCall', () => {
    // The live outage this rule exists for: a GameLogic Pack prefixes the comment it installs, so a
    // startsWith test routed ZERO of School's 5 [PRE] / 3 [POST] / 1 [llmshare] entries and every
    // extra call ran with an empty system block.
    it('matches the tag ANYWHERE in the comment, not only at the start', () => {
        expect(loreEntryMatchesCall(entry({ comment: '[GameLogicPack:school-v4] [PRE] Check_DC_Dice' }), 'PRE')).toBe(true);
        expect(loreEntryMatchesCall(entry({ comment: '[PRE] Check_DC_Dice [GameLogicPack:school-v4]' }), 'PRE')).toBe(true);
        expect(loreEntryMatchesCall(entry({ comment: 'notes — [POST22] tail' }), 'POST22')).toBe(true);
    });

    it('matches a tag anywhere in a KEY too', () => {
        expect(loreEntryMatchesCall(entry({ keys: ['x', '[GameLogicPack:school-v4] [llmshare] Roster'] }), 'llmshare')).toBe(true);
    });

    it('matches by comment prefix (case-insensitive)', () => {
        expect(loreEntryMatchesCall(entry({ comment: '[llm2] classify rules' }), 'llm2')).toBe(true);
        expect(loreEntryMatchesCall(entry({ comment: '[LLM2] DC table' }), 'llm2')).toBe(true);
    });

    it('matches by any key prefix', () => {
        expect(loreEntryMatchesCall(entry({ keys: ['unrelated', '[llm2] roster'] }), 'llm2')).toBe(true);
    });

    it('tolerates leading whitespace and no space after the prefix', () => {
        expect(loreEntryMatchesCall(entry({ comment: '  [llm2]roster' }), 'llm2')).toBe(true);
    });

    it('does NOT match a different call name', () => {
        expect(loreEntryMatchesCall(entry({ comment: '[love] beat' }), 'llm2')).toBe(false);
        expect(loreEntryMatchesCall(entry({ comment: 'img_Mitsuki' }), 'llm2')).toBe(false);
    });

    it('BOUNDARY: "[llm2]" must not match "[llm22]" (the closing bracket guards it)', () => {
        expect(loreEntryMatchesCall(entry({ comment: '[llm22] other call' }), 'llm2')).toBe(false);
        // …and the boundary must survive the tag moving off position 0, which is the whole point
        expect(loreEntryMatchesCall(entry({ comment: '[GameLogicPack:x] [llm22] other call' }), 'llm2')).toBe(false);
        expect(loreEntryMatchesCall(entry({ comment: '[MYPRE31] body' }), 'PRE3')).toBe(false);
    });

    it('returns false for empty name or missing entry', () => {
        expect(loreEntryMatchesCall(entry({ comment: '[llm2] x' }), '')).toBe(false);
        expect(loreEntryMatchesCall(entry({ comment: '[llm2] x' }), '   ')).toBe(false);
        expect(loreEntryMatchesCall(null, 'llm2')).toBe(false);
    });
});

describe('selectLorebookBlock', () => {
    it('joins matching entry contents in order, skipping non-matches', () => {
        const entries = [
            entry({ comment: '[llm2] rules', content: 'RULES' }),
            entry({ comment: 'img_x', content: 'appearance' }),
            entry({ keys: ['[LLM2] dc'], content: 'DC' }),
            entry({ comment: '[llm22] nope', content: 'NOPE' }),
        ];
        expect(selectLorebookBlock(entries, 'llm2')).toBe('RULES\n\nDC');
    });

    it('trims content and drops empties', () => {
        const entries = [
            entry({ comment: '[llm2] a', content: '  A  ' }),
            entry({ comment: '[llm2] blank', content: '   ' }),
        ];
        expect(selectLorebookBlock(entries, 'llm2')).toBe('A');
    });

    it('returns "" for non-array or no matches', () => {
        expect(selectLorebookBlock(null, 'llm2')).toBe('');
        expect(selectLorebookBlock([entry({ comment: '[love] x' })], 'llm2')).toBe('');
    });

    // The card author positions routed blocks with insertion_order (TavernHelper `.order`) — the same
    // numbers that position narrator entries. Higher order = LATER in the block (an index/contract
    // entry given the highest order lands last, closest to the model's recency).
    it('sorts matched entries by .order ascending (higher = later = closest to recency)', () => {
        const entries = [
            entry({ comment: '[llm2] contract', content: 'CONTRACT', order: 990 }),
            entry({ comment: '[llm2] rules', content: 'RULES', order: 780 }),
            entry({ comment: '[llm2] state', content: 'STATE', order: 787 }),
        ];
        expect(selectLorebookBlock(entries, 'llm2')).toBe('RULES\n\nSTATE\n\nCONTRACT');
    });

    it('entries without a numeric order sort as 0 and keep lorebook order on ties', () => {
        const entries = [
            entry({ comment: '[llm2] b-noorder', content: 'B' }),
            entry({ comment: '[llm2] late', content: 'LATE', order: 5 }),
            entry({ comment: '[llm2] a-noorder', content: 'A' }),
        ];
        expect(selectLorebookBlock(entries, 'llm2')).toBe('B\n\nA\n\nLATE');
    });
});

describe('selectCallSystemBlock (groups + call)', () => {
    // llm1, llm2, llm3 calls; groups [llm1and2]={llm1,llm2}, [llm2and3]={llm2,llm3}
    const entries = [
        entry({ comment: '[llm1and2] shared12', content: 'S12' }),
        entry({ comment: '[llm2and3] shared23', content: 'S23' }),
        entry({ comment: '[llm1] a', content: 'A1' }),
        entry({ comment: '[llm2] b', content: 'B2' }),
        entry({ comment: '[llm3] c', content: 'C3' }),
    ];
    const groups = [
        { tag: 'llm1and2', members: ['llm1', 'llm2'] },
        { tag: 'llm2and3', members: ['llm2', 'llm3'] },
    ];

    it('prepends each group the call belongs to (in group order), then the own block', () => {
        expect(selectCallSystemBlock(entries, 'llm1', groups)).toBe('S12\n\nA1');
        expect(selectCallSystemBlock(entries, 'llm3', groups)).toBe('S23\n\nC3');
    });

    it('a call in MULTIPLE groups reads all of them + its own', () => {
        expect(selectCallSystemBlock(entries, 'llm2', groups)).toBe('S12\n\nS23\n\nB2');
    });

    it('a non-member call does not read a group', () => {
        expect(selectCallSystemBlock(entries, 'llm1', groups).includes('S23')).toBe(false);
        expect(selectCallSystemBlock(entries, 'llm3', groups).includes('S12')).toBe(false);
    });

    it('no groups / not an array → just the own block', () => {
        expect(selectCallSystemBlock(entries, 'llm2', [])).toBe('B2');
        expect(selectCallSystemBlock(entries, 'llm2', null)).toBe('B2');
    });

    it('blank tag or empty members are skipped', () => {
        const g = [{ tag: '', members: ['llm2'] }, { tag: 'llm2and3', members: [] }];
        expect(selectCallSystemBlock(entries, 'llm2', g)).toBe('B2');
    });

    it('group tag honours the [name] boundary ([llm2and3] != [llm2and3x])', () => {
        const e = [
            entry({ comment: '[llm2and3] yes', content: 'Y' }),
            entry({ comment: '[llm2and3x] no', content: 'N' }),
            entry({ comment: '[llm2] own', content: 'OWN' }),
        ];
        expect(selectCallSystemBlock(e, 'llm2', [{ tag: 'llm2and3', members: ['llm2'] }])).toBe('Y\n\nOWN');
    });
});

describe('selectCallSystemManifest (per-entry routing log)', () => {
    const entries = [
        entry({ comment: '[llm1and2] shared12', content: 'S12' }),
        entry({ comment: '[llm2and3] shared23', content: 'S23' }),
        entry({ comment: '[llm2] own', content: 'B2' }),
        entry({ comment: '[llm2] empty', content: '   ' }),   // matched but no content → not sent
    ];
    const groups = [
        { tag: 'llm1and2', members: ['llm1', 'llm2'] },
        { tag: 'llm2and3', members: ['llm2', 'llm3'] },
    ];

    it('lists group entries first (in group order), then own — same order as the block', () => {
        expect(selectCallSystemManifest(entries, 'llm2', groups)).toEqual([
            { name: '[llm1and2] shared12', via: 'llm1and2' },
            { name: '[llm2and3] shared23', via: 'llm2and3' },
            { name: '[llm2] own', via: 'self' },
        ]);
    });

    it('skips empty-content entries (mirrors what is actually sent)', () => {
        const names = selectCallSystemManifest(entries, 'llm2', groups).map((m) => m.name);
        expect(names).not.toContain('[llm2] empty');
    });

    it('non-member call gets only its own entries', () => {
        expect(selectCallSystemManifest(entries, 'llm1', groups)).toEqual([
            { name: '[llm1and2] shared12', via: 'llm1and2' },
        ]);
    });

    it('no entries / unnamed → safe defaults', () => {
        expect(selectCallSystemManifest([], 'llm2', groups)).toEqual([]);
        expect(selectCallSystemManifest([entry({ comment: '', content: 'X' })], '', [])).toEqual([]);
    });
});

// ── coreChat read helpers ─────────────────────────────────────────────────────
describe('extractTextContent', () => {
    it('reads string content', () => {
        expect(extractTextContent({ content: 'hello' })).toBe('hello');
    });
    it('reads chat-completion parts arrays (text parts only)', () => {
        const msg = { content: [{ type: 'text', text: 'a' }, { type: 'image_url' }, { type: 'text', text: 'b' }] };
        expect(extractTextContent(msg)).toBe('a\nb');
    });
    it('falls back to .mes (text-completion shape)', () => {
        expect(extractTextContent({ mes: 'legacy' })).toBe('legacy');
    });
    it('prefers content over mes when both exist', () => {
        expect(extractTextContent({ content: 'C', mes: 'M' })).toBe('C');
    });
    it('returns "" for empty/odd input', () => {
        expect(extractTextContent({})).toBe('');
        expect(extractTextContent(null)).toBe('');
    });
});

describe('findLastUserIndex', () => {
    it('finds the last is_user message', () => {
        const chat = [{ is_user: true, mes: 'u1' }, { is_user: false, mes: 'a1' }, { is_user: true, mes: 'u2' }];
        expect(findLastUserIndex(chat)).toBe(2);
    });
    it('finds by role user/human/player', () => {
        expect(findLastUserIndex([{ role: 'system' }, { role: 'user' }])).toBe(1);
        expect(findLastUserIndex([{ role: 'player' }, { role: 'assistant' }])).toBe(0);
    });
    it('falls back to last non-system/assistant role', () => {
        expect(findLastUserIndex([{ role: 'assistant' }, { role: 'tool' }])).toBe(1);
    });
    it('desperation fallback: the very last message', () => {
        expect(findLastUserIndex([{}, {}])).toBe(1);
    });
    it('returns -1 for empty or non-array', () => {
        expect(findLastUserIndex([])).toBe(-1);
        expect(findLastUserIndex(null)).toBe(-1);
    });
});

// ── inject helper ─────────────────────────────────────────────────────────────
describe('prependToMessage', () => {
    it('prepends to string content', () => {
        const msg = { content: 'BODY' };
        expect(prependToMessage(msg, 'PRE\n')).toBe(true);
        expect(msg.content).toBe('PRE\nBODY');
    });
    it('prepends into a parts array, preserving non-text parts', () => {
        const msg = { content: [{ type: 'text', text: 'BODY' }, { type: 'image_url', image_url: 'x' }] };
        expect(prependToMessage(msg, 'PRE\n')).toBe(true);
        expect(msg.content[0]).toEqual({ type: 'text', text: 'PRE\nBODY' });
        expect(msg.content[1]).toEqual({ type: 'image_url', image_url: 'x' });
    });
    it('prepends to .mes shape', () => {
        const msg = { mes: 'BODY' };
        expect(prependToMessage(msg, 'PRE\n')).toBe(true);
        expect(msg.mes).toBe('PRE\nBODY');
    });
    it('returns false for an unknown shape', () => {
        expect(prependToMessage({ foo: 1 }, 'PRE')).toBe(false);
        expect(prependToMessage(null, 'PRE')).toBe(false);
    });
});

// ── request shaping ───────────────────────────────────────────────────────────
describe('buildMessages', () => {
    it('includes a system message only when a block is given', () => {
        expect(buildMessages('SYS', 'hi')).toEqual([
            { role: 'system', content: 'SYS' },
            { role: 'user', content: 'hi' },
        ]);
        expect(buildMessages('', 'hi')).toEqual([{ role: 'user', content: 'hi' }]);
    });
    it('coerces null/undefined user text to ""', () => {
        expect(buildMessages('', null)).toEqual([{ role: 'user', content: '' }]);
    });
});

// ── the player's out-of-character commands ──────────────────────────────────
describe('readOocCommands — the player\'s OOC commands, word for word', () => {
    it('reads a [ooc: …] command exactly as written', () => {
        const line = 'I turn around.\n\n[ooc:  set to outfit="official-maidclothes1"]';
        expect(readOocCommands(line)).toEqual({ commands: ['[ooc:  set to outfit="official-maidclothes1"]'], unclosed: [] });
    });

    it('reads (ooc: …) too, "ooc" in any case, spaces before the colon', () => {
        expect(readOocCommands('(OOC : keep it short) she nods').commands).toEqual(['(OOC : keep it short)']);
        expect(readOocCommands('[Ooc: one]').commands).toEqual(['[Ooc: one]']);
    });

    it('reads every command, in order', () => {
        expect(readOocCommands('a [ooc: one] b (ooc: two) c').commands).toEqual(['[ooc: one]', '(ooc: two)']);
    });

    it('MUTATION TARGET — brackets of the same kind nest inside a command', () => {
        expect(readOocCommands('[ooc: wear the [maid] outfit] then').commands).toEqual(['[ooc: wear the [maid] outfit]']);
        expect(readOocCommands('(ooc: note (aside) end) x').commands).toEqual(['(ooc: note (aside) end)']);
    });

    it('MUTATION TARGET — an opening never closed is no command; its first 40 characters are reported', () => {
        const line = 'hello [ooc: set her outfit to the maid dress from the shop';
        expect(readOocCommands(line)).toEqual({ commands: [], unclosed: ['[ooc: set her outfit to the maid dress f'] });
    });

    it('a command closed before an unclosed one is still read', () => {
        expect(readOocCommands('[ooc: one] and [ooc: two')).toEqual({ commands: ['[ooc: one]'], unclosed: ['[ooc: two'] });
    });

    it('brackets that are not an OOC command are not one', () => {
        expect(readOocCommands('(oocyte: a cell) [note: x] ooc: bare').commands).toEqual([]);
    });

    it('no text reads as no command', () => {
        expect(readOocCommands(undefined)).toEqual({ commands: [], unclosed: [] });
        expect(readOocCommands('')).toEqual({ commands: [], unclosed: [] });
    });
});

describe('buildOocCommandBlock — the block a call is sent', () => {
    it('lists each command on its own line inside <ooc_commands>', () => {
        const block = buildOocCommandBlock(['[ooc: one]', '(ooc: two)']);
        const lines = block.split('\n');
        expect(lines[0]).toBe('<ooc_commands>');
        expect(lines[lines.length - 1]).toBe('</ooc_commands>');
        expect(lines).toContain('[ooc: one]');
        expect(lines).toContain('(ooc: two)');
        expect(block).toContain('admin order from outside the story');
    });

    it('MUTATION TARGET — nothing to send is no block', () => {
        expect(buildOocCommandBlock([])).toBe('');
        expect(buildOocCommandBlock(null)).toBe('');
        expect(buildOocCommandBlock(['  '])).toBe('');
    });
});

describe('oocCommandBlockFor — what one call is sent', () => {
    const line = 'I toss her the maid dress. [ooc: set to outfit="official-maidclothes1"]';
    const command = '[ooc: set to outfit="official-maidclothes1"]';

    it('a POST call, which reads the reply, is sent the command', () => {
        const sent = oocCommandBlockFor(line, 'She puts on the maid dress.');
        expect(sent.carried).toEqual([command]);
        expect(sent.block).toContain(command);
        expect(sent.unclosed).toEqual([]);
    });

    it('MUTATION TARGET — a PRE call, which reads the line itself, is not sent it twice', () => {
        expect(oocCommandBlockFor(line, line)).toEqual({ block: '', carried: [], unclosed: [] });
    });

    it('a call whose input filter cut one command is sent only that one', () => {
        const both = '[ooc: one] act <act>I wave [ooc: two]</act>';
        const sent = oocCommandBlockFor(both, 'I wave [ooc: two]');
        expect(sent.carried).toEqual(['[ooc: one]']);
    });

    it('a call with no player message (the Test button) is sent nothing', () => {
        expect(oocCommandBlockFor(undefined, 'sample')).toEqual({ block: '', carried: [], unclosed: [] });
    });

    it('an unclosed opening is passed on for the warning', () => {
        expect(oocCommandBlockFor('go [ooc: never closed', 'reply').unclosed).toEqual(['[ooc: never closed']);
    });
});

describe('every call is sent the player\'s OOC commands its input leaves out (extra-llm-calls.js wiring)', () => {
    const source = readFileSync('src/features/small-llm/extra-llm-calls.js', 'utf8');

    it('MUTATION TARGET — a call\'s system block is its rules plus the OOC block, built from its filtered input', () => {
        expect(source).toMatch(/const userInput = shapeRoutedCallInput\(call\.name, applyInputFilter\(userText, call\.inputRegex\),\s*\{ phase: macroContext \? macroContext\.stage : null, messageId: snapshotMsgId \}\);\s*const sys = withOocCommands\(rules, userInput, label, macroContext\);\s*const messages = buildMessages\(sys, userInput\);/);
        expect(source).toMatch(/oocCommandBlockFor\(macroContext && macroContext\.userLine, userInput\)/);
        expect(source).toMatch(/return rules \? `\$\{rules\}\\n\\n\$\{block\}` : block;/);
    });

    it('MUTATION TARGET — both phases hand their calls the player\'s message as userLine', () => {
        expect(source).toMatch(/stage: 'pre',\s*chat,\s*userLine: userText,/);
        expect(source).toMatch(/stage: 'post',\s*chat: ctx\.chat,\s*userLine: postUserIdx >= 0 \? extractTextContent\(ctx\.chat\[postUserIdx\]\) : '',/);
    });
});

describe('normalizeMaxTokens', () => {
    it('passes positive numbers through, else undefined', () => {
        expect(normalizeMaxTokens('150')).toBe(150);
        expect(normalizeMaxTokens(200)).toBe(200);
        expect(normalizeMaxTokens('')).toBeUndefined();
        expect(normalizeMaxTokens('0')).toBeUndefined();
        expect(normalizeMaxTokens('abc')).toBeUndefined();
    });
});

describe('buildOverridePayload', () => {
    it('sets temperature only when a real number is provided', () => {
        expect(buildOverridePayload('0.7')).toEqual({ temperature: 0.7 });
        expect(buildOverridePayload(0)).toEqual({ temperature: 0 });
        expect(buildOverridePayload('')).toEqual({});
        expect(buildOverridePayload('   ')).toEqual({});
        expect(buildOverridePayload('hot')).toEqual({});
    });
});

describe('extractCompletionText', () => {
    it('handles string, {content}, {text}, and empties', () => {
        expect(extractCompletionText('out')).toBe('out');
        expect(extractCompletionText({ content: 'c' })).toBe('c');
        expect(extractCompletionText({ text: 't' })).toBe('t');
        expect(extractCompletionText(null)).toBe('');
        expect(extractCompletionText({})).toBe('');
    });
    it('reads the RAW provider shapes (extractData:false)', () => {
        expect(extractCompletionText({ choices: [{ message: { content: 'chat' } }] })).toBe('chat');
        expect(extractCompletionText({ choices: [{ text: 'textcomp' }] })).toBe('textcomp');
        expect(extractCompletionText({ results: [{ text: 'kobold' }] })).toBe('kobold');
        expect(extractCompletionText({ output: 'novel' })).toBe('novel');
    });
});

describe('completionCutReason', () => {
    // MUTATION TARGET — the live 2026-08-31 provider cut. A POST output died at 313 chars on
    // content_filter; without this decision the log reads "1 block(s)" and the lost trailing
    // contracts look like the model declining. Break the gate (always return '') and the
    // content_filter test fails; report every finish and the 'stop' test fails.
    it('names a provider cut, with the native detail when it adds something', () => {
        expect(completionCutReason({ choices: [{ finish_reason: 'content_filter', native_finish_reason: 'PROHIBITED_CONTENT' }] }))
            .toBe('content_filter (native: PROHIBITED_CONTENT)');
        expect(completionCutReason({ choices: [{ finish_reason: 'length' }] })).toBe('length');
        expect(completionCutReason({ choices: [{ finish_reason: 'STOP', native_finish_reason: 'STOP' }] })).toBe('');
    });
    it('stays silent on normal finishes and unreadable shapes', () => {
        expect(completionCutReason({ choices: [{ finish_reason: 'stop' }] })).toBe('');
        expect(completionCutReason({ choices: [{ finish_reason: 'end_turn' }] })).toBe('');
        expect(completionCutReason({ choices: [{ finish_reason: 'tool_calls' }] })).toBe('');
        expect(completionCutReason({ choices: [{}] })).toBe('');
        expect(completionCutReason('a plain string')).toBe('');
        expect(completionCutReason(null)).toBe('');
    });
});

// ── orchestration ─────────────────────────────────────────────────────────────
describe('enabledCalls', () => {
    it('keeps only enabled, named, profile-bound calls', () => {
        const calls = [
            makeCall({ name: 'a' }),
            makeCall({ name: 'b', enabled: false }),
            makeCall({ name: '', id: 'c' }),
            makeCall({ name: 'd', profileId: '' }),
            makeCall({ name: '   ', id: 'e' }),
        ];
        expect(enabledCalls(calls).map((c) => c.name)).toEqual(['a']);
    });
    it('tolerates null/undefined list', () => {
        expect(enabledCalls(null)).toEqual([]);
        expect(enabledCalls(undefined)).toEqual([]);
    });
});

describe('callRunBlocker', () => {
    it('names what keeps a call from running', () => {
        expect(callRunBlocker(makeCall({ name: '' }))).toBe('no-name');
        expect(callRunBlocker(makeCall({ name: '   ', enabled: false }))).toBe('no-name');
        expect(callRunBlocker(makeCall({ name: 'd', profileId: '' }))).toBe('no-connection');
    });
    it('says nothing about a call that runs, or one switched off on purpose', () => {
        expect(callRunBlocker(makeCall({ name: 'a' }))).toBe('');
        expect(callRunBlocker(makeCall({ name: 'b', enabled: false, profileId: '' }))).toBe('');
    });
    it('agrees with enabledCalls on every switched-on call', () => {
        for (const name of ['a', '', ' ']) {
            for (const profileId of ['p1', '']) {
                const call = makeCall({ name, profileId, enabled: true });
                expect(callRunBlocker(call) === '').toBe(enabledCalls([call]).length === 1);
            }
        }
    });
});

describe('callPhase / enabledCallsForPhase', () => {
    it('defaults to pre when phase is missing (back-compat)', () => {
        expect(callPhase(makeCall())).toBe('pre');
        expect(callPhase(makeCall({ phase: undefined }))).toBe('pre');
        expect(callPhase(makeCall({ phase: 'pre' }))).toBe('pre');
        expect(callPhase(makeCall({ phase: 'post' }))).toBe('post');
        expect(callPhase(makeCall({ phase: 'garbage' }))).toBe('pre');
        expect(callPhase(null)).toBe('pre');
    });
    it('splits runnable calls by phase', () => {
        const calls = [
            makeCall({ name: 'p1' }),                       // pre (default)
            makeCall({ name: 'p2', phase: 'pre' }),
            makeCall({ name: 'q1', phase: 'post' }),
            makeCall({ name: 'off', phase: 'post', enabled: false }),
            makeCall({ name: 'noprof', phase: 'post', profileId: '' }),
        ];
        expect(enabledCallsForPhase(calls, 'pre').map((c) => c.name)).toEqual(['p1', 'p2']);
        expect(enabledCallsForPhase(calls, 'post').map((c) => c.name)).toEqual(['q1']);
    });
});

describe('runCalls', () => {
    const calls = [makeCall({ name: 'a' }), makeCall({ name: 'b' })];

    it('parallel (default): returns results aligned to calls', async () => {
        const runOne = async (c) => `out:${c.name}`;
        expect(await runCalls(calls, 'u', runOne, true)).toEqual(['out:a', 'out:b']);
        expect(await runCalls(calls, 'u', runOne, undefined)).toEqual(['out:a', 'out:b']);
    });

    it('sequential: preserves declared order', async () => {
        const order = [];
        const runOne = async (c) => { order.push(c.name); return c.name; };
        const res = await runCalls(calls, 'u', runOne, false);
        expect(res).toEqual(['a', 'b']);
        expect(order).toEqual(['a', 'b']);
    });

    it('a rejecting call maps to null without sinking the batch (parallel)', async () => {
        const runOne = async (c) => { if (c.name === 'a') throw new Error('boom'); return c.name; };
        expect(await runCalls(calls, 'u', runOne, true)).toEqual([null, 'b']);
    });

    it('a rejecting call maps to null without sinking the batch (sequential)', async () => {
        const runOne = async (c) => { if (c.name === 'a') throw new Error('boom'); return c.name; };
        expect(await runCalls(calls, 'u', runOne, false)).toEqual([null, 'b']);
    });

    // keyOf: same-profile calls must NOT overlap (they share a mutable profile object);
    // distinct-profile calls still run concurrently.
    it('keyOf: serializes same-profile calls but runs distinct profiles in parallel', async () => {
        const cs = [
            makeCall({ name: 'a1', profileId: 'P' }),
            makeCall({ name: 'b1', profileId: 'Q' }),
            makeCall({ name: 'a2', profileId: 'P' }),
        ];
        let inP = 0, maxInP = 0;      // concurrency observed for profile P
        let qOverlappedP = false;     // did Q run while a P call was in-flight?
        const active = new Set();
        const defer = () => new Promise((r) => setTimeout(r, 5));
        const runOne = async (c) => {
            if (c.profileId === 'P') { inP++; maxInP = Math.max(maxInP, inP); }
            if (c.profileId === 'Q' && active.size > 0) qOverlappedP = true;
            active.add(c.name);
            await defer();
            active.delete(c.name);
            if (c.profileId === 'P') inP--;
            return c.name;
        };
        const res = await runCalls(cs, 'u', runOne, true, callScheduleKey);
        expect(res).toEqual(['a1', 'b1', 'a2']);   // aligned to input order
        expect(maxInP).toBe(1);                    // P's two calls never overlapped
        expect(qOverlappedP).toBe(true);           // Q ran alongside P (cross-profile parallelism preserved)
    });

    it('keyOf: a rejecting call maps to null and does not block its profile-mates', async () => {
        const cs = [
            makeCall({ name: 'a1', profileId: 'P' }),
            makeCall({ name: 'a2', profileId: 'P' }),
        ];
        const runOne = async (c) => { if (c.name === 'a1') throw new Error('boom'); return c.name; };
        expect(await runCalls(cs, 'u', runOne, true, callScheduleKey)).toEqual([null, 'a2']);
    });
});

describe('postPhaseTimings — one Call timeout per call in the longest chain: a warning halfway, the deadline at the end', () => {
    const T = 60000;
    const post = (name, profileId) => makeCall({ name, profileId, phase: 'post' });

    it('MUTATION TARGET — one POST call: warning at 30 s, deadline at 60 s', () => {
        expect(postPhaseTimings({ calls: [post('POST', 'P')], isParallel: true, callTimeoutMs: T })).toEqual({ warnAtMs: [T / 2], deadlineMs: T });
    });

    it('MUTATION TARGET — no POST call still gets one slot', () => {
        expect(postPhaseTimings({ calls: [], isParallel: true, callTimeoutMs: T })).toEqual({ warnAtMs: [T / 2], deadlineMs: T });
    });

    it('MUTATION TARGET — parallel on: calls on one connection profile run in sequence, each with its own slot', () => {
        const calls = [post('a', 'P'), post('b', 'P'), post('c', 'Q')];
        expect(postPhaseTimings({ calls, isParallel: true, callTimeoutMs: T })).toEqual({ warnAtMs: [T / 2, 1.5 * T], deadlineMs: 2 * T });
    });

    it('MUTATION TARGET — parallel on: calls on different profiles share one slot', () => {
        const calls = [post('a', 'P'), post('b', 'Q')];
        expect(postPhaseTimings({ calls, isParallel: true, callTimeoutMs: T })).toEqual({ warnAtMs: [T / 2], deadlineMs: T });
    });

    it('MUTATION TARGET — parallel off: every call runs in sequence, each with its own slot', () => {
        const calls = [post('a', 'P'), post('b', 'Q')];
        expect(postPhaseTimings({ calls, isParallel: false, callTimeoutMs: T })).toEqual({ warnAtMs: [T / 2, 1.5 * T], deadlineMs: 2 * T });
    });

    it('parallel left unset is on, as runCalls reads it', () => {
        expect(postPhaseTimings({ calls: [post('a', 'P'), post('b', 'Q')], callTimeoutMs: T }).deadlineMs).toBe(T);
    });

    it('the slots follow the Call timeout', () => {
        expect(postPhaseTimings({ calls: [post('a', 'P')], isParallel: true, callTimeoutMs: 30000 })).toEqual({ warnAtMs: [15000], deadlineMs: 30000 });
    });

    it('the timings follow the same schedule key runCalls is given', () => {
        expect(callScheduleKey(post('a', 'P'))).toBe('P');
        expect(callScheduleKey(null)).toBe(undefined);
    });
});

describe('buildInjectionBlock', () => {
    it('wraps each non-empty output in [name]…[/name] blocks', () => {
        const calls = [makeCall({ name: 'a' }), makeCall({ name: 'b' })];
        const block = buildInjectionBlock(calls, ['  OUT_A  ', 'OUT_B']);
        expect(block).toBe('[a]\nOUT_A\n[/a]\n\n[b]\nOUT_B\n[/b]\n\n');
    });
    it('skips null/empty/whitespace outputs', () => {
        const calls = [makeCall({ name: 'a' }), makeCall({ name: 'b' }), makeCall({ name: 'c' })];
        const block = buildInjectionBlock(calls, [null, '   ', 'OUT_C']);
        expect(block).toBe('[c]\nOUT_C\n[/c]\n\n');
    });
    it('returns "" when nothing produced output', () => {
        expect(buildInjectionBlock([makeCall()], [null])).toBe('');
    });
});

describe('extractUpdateVariableBlocks (POST → MVU apply)', () => {
    const UV = (body) => `<UpdateVariable>\n<JSONPatch>\n${body}\n</JSONPatch>\n</UpdateVariable>`;
    it('pulls a single block out of surrounding prose', () => {
        const out = `sure, recorded:\n${UV('[ { "op": "replace", "path": "/World/Time/0", "value": "18:25" } ]')}\ndone`;
        const blocks = extractUpdateVariableBlocks(out);
        expect(blocks.length).toBe(1);
        expect(blocks[0]).toContain('/World/Time/0');
        expect(blocks[0].startsWith('<UpdateVariable>')).toBe(true);
        expect(blocks[0].endsWith('</UpdateVariable>')).toBe(true);
    });
    it('drops an empty patch ([] or whitespace)', () => {
        expect(extractUpdateVariableBlocks(UV('[]')).length).toBe(0);
        expect(extractUpdateVariableBlocks(UV('   ')).length).toBe(0);
    });
    it('returns every non-empty block, skipping empty ones', () => {
        const out = UV('[]') + '\n' + UV('[ { "op": "replace", "path": "/a/0", "value": 1 } ]');
        expect(extractUpdateVariableBlocks(out).length).toBe(1);
    });
    it('tolerates null/undefined/no-block', () => {
        expect(extractUpdateVariableBlocks(null)).toEqual([]);
        expect(extractUpdateVariableBlocks('no block here')).toEqual([]);
    });
});

describe('classifyPostOutput ("deliberately nothing" vs a real contract break)', () => {
    const UV = (body) => `<UpdateVariable>\n<JSONPatch>\n${body}\n</JSONPatch>\n</UpdateVariable>`;
    it('ok — wrapper with real ops', () => {
        expect(classifyPostOutput(UV('[ { "op": "replace", "path": "/a/0", "value": 1 } ]'))).toBe('ok');
    });
    it('ok-empty — the contract\'s quiet-turn answer (well-formed wrapper, [] patch) must NOT warn', () => {
        expect(classifyPostOutput(UV('[]'))).toBe('ok-empty');       // the exact live false-positive (2026-07-04)
        expect(classifyPostOutput(UV('   '))).toBe('ok-empty');
    });
    it('bare-empty — [] / empty <JSONPatch> without the wrapper: off-contract but unambiguously "nothing"', () => {
        expect(classifyPostOutput('[]')).toBe('bare-empty');
        expect(classifyPostOutput('<JSONPatch>[]</JSONPatch>')).toBe('bare-empty');
    });
    it('lost-ops — patch content OUTSIDE the wrapper (extractor would drop it → data loss)', () => {
        expect(classifyPostOutput('<JSONPatch>[ { "op": "replace", "path": "/a/0", "value": 1 } ]</JSONPatch>')).toBe('lost-ops');
        expect(classifyPostOutput('[ { "op": "replace", "path": "/a/0", "value": 1 } ]')).toBe('lost-ops');
    });
    it('prose — no patch structure at all', () => {
        expect(classifyPostOutput('Nothing to record this turn.')).toBe('prose');
    });
    it('empty — no output (the empty-result summary covers it)', () => {
        expect(classifyPostOutput('')).toBe('empty');
        expect(classifyPostOutput(null)).toBe('empty');
    });
});

describe('checkCallOutput (per-call output-check regex — THE shared PRE/POST verdict)', () => {
    it('no pattern configured → always ok', () => {
        expect(checkCallOutput('anything', '')).toEqual({ ok: true });
        expect(checkCallOutput('anything', null)).toEqual({ ok: true });
    });
    it('matching output → ok (bare pattern, default `s` flag spans newlines)', () => {
        expect(checkCallOutput('{\n "check": {} \n}', '^\\s*\\{[\\s\\S]*\\}\\s*$').ok).toBe(true);
    });
    it('non-matching output → not ok (the caller drops it as garbage)', () => {
        expect(checkCallOutput('Sorry, I cannot help with that.', '^\\s*\\{[\\s\\S]*\\}\\s*$').ok).toBe(false);
    });
    it('supports /pattern/flags syntax like the input filter', () => {
        expect(checkCallOutput('<UPDATEVARIABLE>x</UPDATEVARIABLE>', '/<updatevariable>/i').ok).toBe(true);
    });
    it('invalid pattern → { ok:false, invalid:true } (caller keeps the output + warns)', () => {
        expect(checkCallOutput('x', '[unclosed')).toEqual({ ok: false, invalid: true });
    });
});

describe('stripPatchBlocks + applyInputFilter (POST input trim)', () => {
    const UV = '<UpdateVariable>\n<JSONPatch>\n[ { "op": "replace", "path": "/a/0", "value": 1 } ]\n</JSONPatch>\n</UpdateVariable>';
    it('strips the narrator\'s UpdateVariable block(s) from a reply', () => {
        const reply = '<gametxt>She smiles.</gametxt>\n\n' + UV + '\n\n<progress>PG.1</progress>';
        const out = stripPatchBlocks(reply);
        expect(out).not.toContain('<UpdateVariable>');
        expect(out).toContain('<gametxt>She smiles.</gametxt>');
        expect(out).toContain('<progress>PG.1</progress>');
    });
    it('strip tolerates null and no-block', () => {
        expect(stripPatchBlocks(null)).toBe('');
        expect(stripPatchBlocks('plain prose')).toBe('plain prose');
    });
    it('toPostWrapper renames the wrapper but preserves the inner <JSONPatch> (MVU still applies it)', () => {
        const uv = '<UpdateVariable>\n<JSONPatch>\n[{"op":"replace","path":"/Intent/armClassmate/0","value":true}]\n</JSONPatch>\n</UpdateVariable>';
        const out = toPostWrapper(uv);
        expect(out).toContain('<POSTUpdateVariable>');
        expect(out).toContain('</POSTUpdateVariable>');
        expect(out).not.toMatch(/<\/?UpdateVariable>/);          // no bare UpdateVariable wrapper left
        expect(out).toContain('<JSONPatch>');                    // inner untouched → MVU's json_patch matchAll still finds it
        expect(out).toContain('/Intent/armClassmate/0');
    });
    it('toPostWrapper tolerates null/empty', () => {
        expect(toPostWrapper(null)).toBe('');
        expect(toPostWrapper('')).toBe('');
    });
    it('MVU\'s real json_patch extractor STILL finds the op inside the renamed <POSTUpdateVariable> wrapper', () => {
        // This is the arbiter: encode MVU's ACTUAL op extractor (copied verbatim from the bundle — a global,
        // wrapper-agnostic matchAll on <json_?patch>) and prove the rename doesn't hide POST's ops from it.
        // If MVU ever keyed on the outer <UpdateVariable> wrapper, this test would fail — no prose note needed.
        const MVU_JSONPATCH = /<(json_?patch)>(?:\s*```.*)?((?:(?!<json_?patch>)[\s\S])*?)(?:```\s*)?<\/\1>/gim;
        const posted = toPostWrapper('<UpdateVariable>\n<JSONPatch>\n[{"op":"replace","path":"/Intent/armClassmate/0","value":true}]\n</JSONPatch>\n</UpdateVariable>');
        const matches = [...posted.matchAll(MVU_JSONPATCH)];
        expect(matches.length).toBe(1);                         // MVU finds exactly one patch block
        const ops = JSON.parse(matches[0][2].trim());
        expect(ops[0].path).toBe('/Intent/armClassmate/0');     // …and the op is intact
        expect(ops[0].value).toBe(true);
    });
    // MVU applies a <json_?patch> block wherever it sits, so a narrator that drops the wrapper still
    // writes state. Its patch must leave POST's input the same as a wrapped one, or POST echoes it back.
    it('strips a bare <JSONPatch> standing outside any wrapper, as MVU\'s own extractor finds it', () => {
        const bare = '<JSONPatch>\n[ { "op": "replace", "path": "/a/0", "value": 1 } ]\n</JSONPatch>';
        const out = stripPatchBlocks('<gametxt>She smiles.</gametxt>\n\n' + bare + '\n\n<progress>PG.1</progress>');
        expect(out).not.toContain('JSONPatch');
        expect(out).not.toContain('/a/0');
        expect(out).toBe('<gametxt>She smiles.</gametxt>\n\n<progress>PG.1</progress>');
    });
    it('strips the other spellings MVU accepts (json_patch, any case)', () => {
        expect(stripPatchBlocks('a <json_patch>[]</json_patch> b')).toBe('a  b');
        expect(stripPatchBlocks('a <jsonpatch>[]</JSONPATCH> b')).toBe('a  b');
    });
    it('the WRAPPER-only strip keeps a bare <JSONPatch> — POST\'s own output needs it visible to be flagged lost-ops', () => {
        const bare = '<JSONPatch>[{"op":"replace","path":"/a/0","value":1}]</JSONPatch>';
        expect(stripUpdateVariableBlocks('note\n\n' + bare)).toBe('note\n\n' + bare);
        expect(splitAndCheckPostOutput('note\n\n' + bare, '').prose).toContain('<JSONPatch>');
    });
    it('leaves prose that only MENTIONS a patch alone (no block, nothing stripped)', () => {
        expect(stripPatchBlocks('the word JSONPatch in a sentence')).toBe('the word JSONPatch in a sentence');
    });
    it('also strips POST\'s renamed <POSTUpdateVariable> block (so POST never re-reads its own relay)', () => {
        const POST = '<POSTUpdateVariable>\n<JSONPatch>\n[ { "op": "replace", "path": "/Intent/armClassmate/0", "value": true } ]\n</JSONPatch>\n</POSTUpdateVariable>';
        const reply = '<gametxt>Scene.</gametxt>\n\n' + UV + '\n\n' + POST + '\n\n<progress>PG.1</progress>';
        const out = stripPatchBlocks(reply);
        expect(out).not.toContain('<UpdateVariable>');
        expect(out).not.toContain('<POSTUpdateVariable>');
        expect(out).toContain('<gametxt>Scene.</gametxt>');
        expect(out).toContain('<progress>PG.1</progress>');
    });
    it('input filter extracts capture group 1 (multiline)', () => {
        const reply = 'pre\n<gametxt>\nline A\nline B\n</gametxt>\npost';
        expect(applyInputFilter(reply, '<gametxt>([\\s\\S]*?)</gametxt>')).toBe('line A\nline B');
    });
    it('input filter returns whole match when no capture group', () => {
        expect(applyInputFilter('xx[KEEP]yy', '\\[KEEP\\]')).toBe('[KEEP]');
    });
    it('input filter: empty/blank pattern → unchanged; no match → unchanged', () => {
        expect(applyInputFilter('hello', '')).toBe('hello');
        expect(applyInputFilter('hello', '<gametxt>(.*?)</gametxt>')).toBe('hello');
    });
    it('input filter: bad regex → unchanged (never throws)', () => {
        expect(applyInputFilter('hello', '([')).toBe('hello');
    });
    it('input filter accepts /pattern/flags form', () => {
        expect(applyInputFilter('AbC', '/b/i')).toBe('b');
    });
});

describe('parseInputFilterRegex (invalid-regex signal for the runtime toast)', () => {
    it('empty/blank pattern → { re: null }, not invalid', () => {
        expect(parseInputFilterRegex('')).toEqual({ re: null });
        expect(parseInputFilterRegex('   ')).toEqual({ re: null });
        expect(parseInputFilterRegex(null)).toEqual({ re: null });
    });
    it('valid pattern → a usable RegExp, not flagged invalid', () => {
        const r = parseInputFilterRegex('<gametxt>([\\s\\S]*?)</gametxt>');
        expect(r.re).toBeInstanceOf(RegExp);
        expect(r.invalid).toBeUndefined();
    });
    it('/pattern/flags form compiles with its flags', () => {
        expect(parseInputFilterRegex('/b/i').re.flags).toContain('i');
    });
    it('bad regex → { re: null, invalid: true } (the toast trigger)', () => {
        expect(parseInputFilterRegex('([')).toEqual({ re: null, invalid: true });
        expect(parseInputFilterRegex('/(/')).toEqual({ re: null, invalid: true });
    });
});

describe('postOpsRefused — POST\'s own "did my ops land" probe (the last lane without one)', () => {
    const UV = (ops) => `<UpdateVariable>\n<JSONPatch>\n${JSON.stringify(ops)}\n</JSONPatch>\n</UpdateVariable>`;

    // ▲ THE KNOWN BLIND SPOT, PINNED — and it is the very case that prompted this probe, so it must
    // be a test rather than a hope. Live 2026-08-17: POST emitted `add` on the TUPLE path
    // /Intent/armClassmate/0 where its prompt prints `replace`; the insert overran the declared
    // length of 2 and Zod reverted THAT op alone, so the new-heroine gate never armed. But a
    // reverted insert leaves the path PRESENT (index 0 still reads `false`), and this probe asks
    // "does the path exist" — so it reports nothing. Detecting it needs the sent VALUE compared
    // against the stored one, which is unsafe here (the relay fired by this same parse can
    // legitimately overwrite a path afterwards). If this test ever starts failing, someone added
    // value comparison — make sure they handled the relay-overwrite false positive first.
    it('does NOT see a reverted tuple insert — the path survives, so a path probe cannot catch it', () => {
        const blocks = [UV([
            { op: 'add', path: '/Intent/armClassmate/0', value: true },
            { op: 'replace', path: '/Intent/initiative/0', value: 'Mitsuki:3' },
        ])];
        const applied = { stat_data: { Intent: { armClassmate: [false, '預備新增同學'], initiative: ['Mitsuki:3', '主動行動'] } } };
        expect(postOpsRefused(blocks, applied)).toEqual({ sent: 2, refused: [], allRefused: false });
    });

    it('reports a path that is genuinely absent — a new key on a closed root', () => {
        const blocks = [UV([
            { op: 'add', path: '/World/LaneProbeMustRefuse', value: 'must be refused' },
            { op: 'replace', path: '/World/Weather/0', value: 'Storm' },
        ])];
        const applied = { stat_data: { World: { Weather: ['Storm', '天氣'] } } };
        const r = postOpsRefused(blocks, applied);
        expect(r.sent).toBe(2);
        expect(r.refused).toEqual(['/World/LaneProbeMustRefuse']);
        expect(r.allRefused).toBe(false);
    });

    it('reads EVERY block, not just the first — the game\'s and a plugin\'s ride one reply', () => {
        const blocks = [
            UV([{ op: 'replace', path: '/Intent/initiative/0', value: 'Mitsuki:3' }]),
            UV([{ op: 'add', path: '/GameLogicPlugin/lane_probe/Turn', value: 1 },
                { op: 'add', path: '/World/RelayMustRefuse', value: 'x' }]),
        ];
        const applied = { stat_data: { Intent: { initiative: ['Mitsuki:3', '主動行動'] }, GameLogicPlugin: { lane_probe: { Turn: [1, 'Turn'] } }, World: {} } };
        const r = postOpsRefused(blocks, applied);
        expect(r.sent).toBe(3);
        expect(r.refused).toEqual(['/World/RelayMustRefuse']);
    });

    it('a null apply with ops sent is allRefused — the COUNT is a fact, the paths would be a guess', () => {
        const r = postOpsRefused([UV([{ op: 'add', path: '/A/x', value: 1 }])], null);
        expect(r).toEqual({ sent: 1, refused: [], allRefused: true });
    });

    it('a quiet POST is never reported — no blocks, or blocks with nothing in them', () => {
        expect(postOpsRefused([], null)).toEqual({ sent: 0, refused: [], allRefused: false });
        expect(postOpsRefused([UV([])], null)).toEqual({ sent: 0, refused: [], allRefused: false });
        expect(postOpsRefused(undefined, { stat_data: {} })).toEqual({ sent: 0, refused: [], allRefused: false });
    });

    it('`remove` is never refused-looking — absent IS its success case', () => {
        const r = postOpsRefused([UV([{ op: 'remove', path: '/Intent/check/0' }])], { stat_data: { Intent: {} } });
        expect(r.refused).toEqual([]);
    });
});

describe('parsePatchOps (POST relay logging)', () => {
    const block = '<UpdateVariable>\n<JSONPatch>\n[ { "op": "replace", "path": "/Intent/armClassmate/0", "value": true } ]\n</JSONPatch>\n</UpdateVariable>';
    it('parses ops out of a JSONPatch block', () => {
        const ops = parsePatchOps(block);
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ op: 'replace', path: '/Intent/armClassmate/0', value: true });
    });
    it('accepts a bare JSON array body too', () => {
        expect(parsePatchOps('[{ "op":"add","path":"/x","value":1 }]')).toHaveLength(1);
    });
    it('tolerant: missing/invalid/non-array → []', () => {
        expect(parsePatchOps(null)).toEqual([]);
        expect(parsePatchOps('<UpdateVariable></UpdateVariable>')).toEqual([]);
        expect(parsePatchOps('<JSONPatch>not json</JSONPatch>')).toEqual([]);
        expect(parsePatchOps('<JSONPatch>{"op":"x"}</JSONPatch>')).toEqual([]); // object, not array
    });
    // (getAtPointer, which reads the tuple value these ops address, is shared/json-patch-ops.js and
    // is proved in tests/json-patch-ops.test.js — the §23 relay reads applied paths with it too.)
});

describe('renderEjsBlock (ST-Prompt-Template render of [PRE]/[POST] EJS)', () => {
    // A minimal fake of globalThis.EjsTemplate. records what it was called with.
    const makeEjs = (impl) => {
        const calls = { evalTemplate: [], prepareContext: [] };
        const api = {
            evalTemplate: async (code, ctx) => { calls.evalTemplate.push([code, ctx]); return impl ? impl(code, ctx) : `RENDERED(${code})`; },
            prepareContext: async (env, end) => { calls.prepareContext.push([env, end]); return { __ctx: true, end }; },
        };
        return { api, calls };
    };

    it('no `<%` delimiter → returned unchanged, engine untouched, no onMissing', async () => {
        const { api, calls } = makeEjs();
        let missed = false;
        const out = await renderEjsBlock(api, 'plain roster text, no template', { onMissing: () => { missed = true; } });
        expect(out).toBe('plain roster text, no template');
        expect(calls.evalTemplate).toHaveLength(0);
        expect(missed).toBe(false);                              // non-EJS blocks never warn (no ST-Prompt-Template needed)
    });

    it('`<%` present but engine missing → onMissing fires and the RAW block is returned', async () => {
        let missedWith = null;
        const out = await renderEjsBlock(null, 'Aff = <%= getvar("aff") %>', { onMissing: (raw) => { missedWith = raw; } });
        expect(out).toBe('Aff = <%= getvar("aff") %>');         // graceful degrade to raw
        expect(missedWith).toBe('Aff = <%= getvar("aff") %>');
    });

    it('engine present → evalTemplate is called and its output is returned', async () => {
        const { api, calls } = makeEjs(() => 'Aff = 42');
        const out = await renderEjsBlock(api, 'Aff = <%= getvar("aff") %>');
        expect(out).toBe('Aff = 42');
        expect(calls.evalTemplate).toHaveLength(1);
        expect(calls.evalTemplate[0][0]).toBe('Aff = <%= getvar("aff") %>');
        expect(calls.evalTemplate[0][1]).toBe(null);            // no snapshotMsgId → null ctx (engine builds latest)
    });

    it('snapshotMsgId → prepareContext({message_id}, id) — the env pin that makes every getvar re-cache to the PINNED floor (D1)', async () => {
        const { api, calls } = makeEjs();
        await renderEjsBlock(api, 'x <%= 1 %>', { snapshotMsgId: 7 });
        expect(calls.prepareContext).toHaveLength(1);
        // env carries message_id: env is spread LAST into the context, and a with(locals) lookup
        // calls getvar as a METHOD, so this.message_id re-pins the vars cache on EVERY call.
        expect(calls.prepareContext[0]).toEqual([{ message_id: 7 }, 7]);
        expect(calls.evalTemplate[0][1]).toMatchObject({ __ctx: true, end: 7 });
    });

    it('the getvar override rebinds `this` — a BARE getvar call (with_context_disabled) still resolves the pinned floor (D1)', async () => {
        const seenThis = [];
        const api = {
            prepareContext: async (env, end) => ({
                ...env, end,
                getvar: function (key) { seenThis.push(this && this.message_id); return `v(${key})`; },
            }),
            evalTemplate: async (code, ctx) => {
                const bare = ctx.getvar;                         // destructured locals: called with no receiver
                return bare('stat_data');
            },
        };
        const out = await renderEjsBlock(api, 'x <%= getvar("stat_data") %>', { snapshotMsgId: 12 });
        expect(out).toBe('v(stat_data)');
        expect(seenThis).toEqual([12]);                          // `this` was rebound to { message_id: 12 }
    });

    it('a prepared ctx WITHOUT getvar is passed through untouched (no crash, no synthetic getvar)', async () => {
        const { api, calls } = makeEjs();
        await renderEjsBlock(api, 'x <%= 1 %>', { snapshotMsgId: 3 });
        expect(calls.evalTemplate[0][1].getvar).toBeUndefined();
    });

    it('render throws → onError fires and the RAW block is returned', async () => {
        const boom = { evalTemplate: async () => { throw new Error('EJS SyntaxError'); } };
        let errWith = null;
        const out = await renderEjsBlock(boom, 'bad <% for( %>', { onError: (e) => { errWith = e; } });
        expect(out).toBe('bad <% for( %>');                     // degrade to raw on error
        expect(errWith).toBeInstanceOf(Error);
    });

    it('tolerates null/empty text', async () => {
        const { api } = makeEjs();
        expect(await renderEjsBlock(api, null)).toBe('');
        expect(await renderEjsBlock(api, '')).toBe('');
    });

    it('engine returning null/undefined → falls back to the raw block (never emits "null")', async () => {
        const nullish = { evalTemplate: async () => null };
        expect(await renderEjsBlock(nullish, 'keep <%= x %>')).toBe('keep <%= x %>');
    });
});

describe('findBaseFloorIndex (PRE_Call_Revisit D1 — the floor PRE reads instead of the user floor)', () => {
    const ai = (stat) => ({ is_user: false, swipe_id: 0, variables: stat ? { 0: { stat_data: stat } } : undefined });
    const user = () => ({ is_user: true });
    const system = () => ({ is_user: false, is_system: true });   // no variables → hasState false

    it('normal turn: the assistant floor with state before the last user floor', () => {
        expect(findBaseFloorIndex([ai({ x: 1 }), user()])).toBe(0);
    });
    it('skips assistant floors WITHOUT stat_data (system notes, floors MVU never wrote)', () => {
        expect(findBaseFloorIndex([ai({ x: 1 }), ai(null), user()])).toBe(0);
        expect(findBaseFloorIndex([ai({ x: 1 }), system(), user()])).toBe(0);
    });
    it('user-first chat (no assistant before the user) → the USER floor, explicitly — never -1-as-last', () => {
        // A naive findLastIndex returns -1 here, and the vars cache resolves -1 as chat.length-1 =
        // the DIRTY floor. The fallback must be the user floor by name.
        expect(findBaseFloorIndex([user()])).toBe(0);
        expect(findBaseFloorIndex([user(), ai({ x: 1 }), user()])).toBe(1);
    });
    it('honors the message\'s CURRENT swipe_id when checking for state', () => {
        const swiped = { is_user: false, swipe_id: 1, variables: { 1: { stat_data: { x: 1 } } } };
        expect(findBaseFloorIndex([swiped, user()])).toBe(0);
        const wrongSlot = { is_user: false, swipe_id: 1, variables: { 0: { stat_data: { x: 1 } } } };
        expect(findBaseFloorIndex([wrongSlot, user()])).toBe(1);  // state under a different swipe → not a base
    });
    it('no user floor at all: last assistant-with-state; desperation fallback = last index', () => {
        expect(findBaseFloorIndex([ai({ x: 1 }), ai(null)])).toBe(0);
        expect(findBaseFloorIndex([ai(null)])).toBe(0);           // nothing qualifies → last index, never -1
    });
    it('empty / non-array chat → -1 (the caller already bails on an empty chat)', () => {
        expect(findBaseFloorIndex([])).toBe(-1);
        expect(findBaseFloorIndex(null)).toBe(-1);
    });
});

// ── P8 §6.6 actor-3: same-round event — the engine's pick, read strictly ──────────────────────────
// The engine's pickSameRoundEvent decides WHICH event plays (its own PRE field, its own candidates);
// mvu-helper only reads the answer. No fallback: a malformed answer plays nothing and says what it was.
describe('readSameRoundPick (what the engine\'s pickSameRoundEvent returned)', () => {
    it('a string is the key, trimmed', () => {
        expect(readSameRoundPick('leila_1')).toEqual({ key: 'leila_1', problem: '' });
        expect(readSameRoundPick('  leila_1 \n')).toEqual({ key: 'leila_1', problem: '' });
    });
    it('empty, null and undefined mean "play nothing", with no problem to report', () => {
        expect(readSameRoundPick('')).toEqual({ key: '', problem: '' });
        expect(readSameRoundPick('   ')).toEqual({ key: '', problem: '' });
        expect(readSameRoundPick(null)).toEqual({ key: '', problem: '' });
        expect(readSameRoundPick(undefined)).toEqual({ key: '', problem: '' });
    });
    it('anything else plays nothing and names what came back — no key is guessed out of it', () => {
        for (const [value, what] of [[{ key: 'leila_1' }, 'an object'], [['leila_1'], 'an array'], [7, 'a number'], [true, 'a boolean']]) {
            const r = readSameRoundPick(value);
            expect(r.key).toBe('');
            expect(r.problem).toContain(`returned ${what}`);
            expect(r.problem).toContain('pickSameRoundEvent');
        }
    });
});

// What the PRE-rail engine hooks read about each call: its raw output and the ops its patch landed. The engine reads
// a call's writes from appliedOps, so it never parses a patch a second, different way. The ops here are a made-up
// card's, so no consumer's vocabulary is taught.
describe('preHookOutputs — each PRE call as the engine hooks see it', () => {
    const outputs = [{ name: 'PRE', label: 'PRE', output: '{"verdict":"x"}<JSONPatch>[...]</JSONPatch>' }, { name: 'PRE2', label: 'PRE2', output: 'prose only' }];
    const landed = [{ op: 'replace', path: '/Town/Gate/0', value: 'open' }];

    it('MUTATION TARGET — a call that applied ops carries them; one that applied none carries []', () => {
        expect(preHookOutputs(outputs, [landed, []])).toEqual([
            { name: 'PRE', output: outputs[0].output, appliedOps: landed },
            { name: 'PRE2', output: 'prose only', appliedOps: [] },
        ]);
    });
    it('the raw output rides along untouched, and the label stays the page buffer\'s', () => {
        const [first] = preHookOutputs(outputs, [landed]);
        expect(first.output).toBe(outputs[0].output);
        expect(first).not.toHaveProperty('label');
    });
    it('a call past the end of the applied list, or a missing list, carries []', () => {
        expect(preHookOutputs(outputs, [landed]).map((o) => o.appliedOps)).toEqual([landed, []]);
        expect(preHookOutputs(outputs).map((o) => o.appliedOps)).toEqual([[], []]);
        expect(preHookOutputs(null, [landed])).toEqual([]);
    });
    it('the hook gets its own list: a later push onto the source never reaches it', () => {
        const source = [...landed];
        const [first] = preHookOutputs(outputs, [source]);
        source.push({ op: 'replace', path: '/Town/Bell/0', value: 'rung' });
        expect(first.appliedOps).toEqual(landed);
    });
});

// The PRE pass is in the host-coupled extra-llm-calls.js, so the lines that feed the hooks are gated as SOURCE.
// MUTATION TARGETS: record the ops before the apply's verdict, or hand either hook the raw outputs again, and these fail.
describe('SOURCE GATE — both PRE-rail hooks get what each call applied (extra-llm-calls.js)', () => {
    const source = readFileSync('src/features/small-llm/extra-llm-calls.js', 'utf8').replace(/\r\n/g, '\n');

    it('only a patch that applied is recorded for the hooks', () => {
        expect(source).toContain('const ok = await applySimBlockAtPre({ label, block, ops, entryEpoch, uReal });\n            if (ok) appliedOpsByCall[i] = ops;');
    });
    it('preVerdictPatch and pickSameRoundEvent are handed the same preHookOutputs list', () => {
        expect(source).toContain('const hookPreOutputs = preHookOutputs(preOutputs, appliedOpsByCall);');
        expect(source).toContain("await applyEngineRailPatch('preVerdictPatch', baseFloor, uReal, entryEpoch, { ...turnContext, preOutputs: hookPreOutputs });");
        expect(source).toContain('sameRound = await buildSameRoundEventBlock(hookPreOutputs, baseFloor, uReal, turnContext);');
        expect(source).not.toContain('preOutputs.map((o) => ({ name: o.name, output: o.output }))');
    });
});

// ── persistent PRE / sim calls (LOGIC_ENGINE_PLAN §9a.2) ─────────────────────
describe('validateSimPatchOutput (strict STRUCTURALLY — but path-scope-free since P0)', () => {
    const op = { op: 'replace', path: '/World_Cities/Ironhold', value: 'under siege by army X' };

    it('accepts a bare <JSONPatch> block and rebuilds the canonical block from PARSED ops', () => {
        const r = validateSimPatchOutput(`prose around it <JSONPatch>${JSON.stringify([op])}</JSONPatch> more prose`);
        expect(r.ok).toBe(true);
        expect(r.ops).toEqual([op]);
        expect(r.block).toBe(`<JSONPatch>${JSON.stringify([op])}</JSONPatch>`);
    });
    it('tolerates an <UpdateVariable> wrapper and a naked JSON array', () => {
        expect(validateSimPatchOutput(`<UpdateVariable><JSONPatch>${JSON.stringify([op])}</JSONPatch></UpdateVariable>`).ok).toBe(true);
        expect(validateSimPatchOutput(JSON.stringify([op])).ok).toBe(true);
    });
    it('a well-formed EMPTY patch is ok:true with nothing to apply (quiet turn, not an error)', () => {
        const r = validateSimPatchOutput('<JSONPatch>[]</JSONPatch>');
        expect(r).toEqual({ ok: true, ops: [], block: '', dropped: [] });
    });
    it('TRUNCATED JSON is a detected failure — the exact case the tolerant parser hides', () => {
        const truncated = '<JSONPatch>[{"op":"replace","path":"/World_Cities/Ironhold","value":"burned</JSONPatch>';
        expect(parsePatchOps(truncated)).toEqual([]);                        // the tolerant helper swallows it…
        const r = validateSimPatchOutput(truncated);
        expect(r.ok).toBe(false);                                            // …this one refuses it, with a reason
        expect(r.reason).toMatch(/not valid JSON/);
    });
    // ok:false is reserved for a block that is unusable AS A WHOLE. A block that parses but holds
    // junk is ok:true with the junk in `dropped` — the per-op salvage below.
    it('rejects the WHOLE block only when it is unusable: no block · non-array · truncated', () => {
        expect(validateSimPatchOutput('the cities remain peaceful').ok).toBe(false);
        expect(validateSimPatchOutput('<JSONPatch>{"op":"replace"}</JSONPatch>').ok).toBe(false);
    });
    it('a malformed op is DROPPED, not fatal — verb off the whitelist · missing path · missing value', () => {
        for (const [bad, why] of [
            ['{"op":"delete","path":"/World_Cities/x","value":1}', /verb "delete"/],
            ['{"op":"replace","value":1}', /JSON-Pointer path/],
            ['{"op":"replace","path":"/World_Cities/x"}', /has no value/],
            ['"not even an object"', /not an object/],
        ]) {
            const r = validateSimPatchOutput(`<JSONPatch>[${JSON.stringify(op)},${bad}]</JSONPatch>`);
            expect(r.ok).toBe(true);
            expect(r.ops).toEqual([op]);                                     // the good op SURVIVES
            expect(r.dropped).toHaveLength(1);
            expect(r.dropped[0].index).toBe(1);
            expect(r.dropped[0].reason).toMatch(why);
            expect(r.block).toBe(`<JSONPatch>${JSON.stringify([op])}</JSONPatch>`);   // rebuilt WITHOUT it
        }
    });
    // The whole point of the change: on School's PRE, `/Intent/check/0` is the dice report, and
    // losing it to a neighbouring entry's junk op costs the turn its check resolution.
    it('SALVAGE: a junk op from one lorebook entry cannot void another entry\'s op', () => {
        const check = { op: 'replace', path: '/Intent/check/0', value: 'target:Mitsuki;rawdie:14' };
        const junk = { op: 'append', path: '/SomeOther/Log', value: ['x'] };
        const r = validateSimPatchOutput(`<JSONPatch>${JSON.stringify([junk, check])}</JSONPatch>`);
        expect(r.ok).toBe(true);
        expect(r.ops).toEqual([check]);
        expect(r.dropped[0].index).toBe(0);
    });
    it('every op dropped is ok:true with ops:[] AND a non-empty dropped — never a quiet turn', () => {
        const r = validateSimPatchOutput('<JSONPatch>[{"op":"delete","path":"/x","value":1}]</JSONPatch>');
        expect(r.ok).toBe(true);
        expect(r.ops).toEqual([]);
        expect(r.block).toBe('');
        expect(r.dropped).toHaveLength(1);          // distinguishes it from the well-formed empty patch
    });
    it('remove needs no value', () => {
        expect(validateSimPatchOutput('<JSONPatch>[{"op":"remove","path":"/World_Cities/Ghosttown"}]</JSONPatch>').ok).toBe(true);
    });
    it('P0: ANY Zod-legal path is structurally valid — the pre-P0 "escapes the owned root" rejection is gone', () => {
        // These exact shapes were the boundary-breach fixtures before P0; the card's Zod (strict
        // strip) + the host's per-op after-apply probe own the hallucinated-path case now.
        expect(validateSimPatchOutput('<JSONPatch>[{"op":"replace","path":"/Mainchar/Money/0","value":99999}]</JSONPatch>').ok).toBe(true);
        const mixed = [op, { op: 'replace', path: '/Mainchar/Money/0', value: 1 }];
        expect(validateSimPatchOutput(`<JSONPatch>${JSON.stringify(mixed)}</JSONPatch>`).ok).toBe(true);
    });
});

describe('renderSimInjectLines (the inject is DERIVED from the ops — drift impossible)', () => {
    it('one line per op: the FULL dotted path > value', () => {
        expect(renderSimInjectLines([
            { op: 'replace', path: '/World_Cities/Ironhold', value: 'under siege by army X' },
            { op: 'add', path: '/World_Cities/Newport/status', value: 'founded by refugees' },
        ])).toBe('World_Cities.Ironhold > under siege by army X\nWorld_Cities.Newport.status > founded by refugees');
    });
    it('remove renders as no-longer-tracked; non-string values stringify', () => {
        expect(renderSimInjectLines([{ op: 'remove', path: '/World_Cities/Ghosttown' }])).toBe('World_Cities.Ghosttown > (no longer tracked)');
        expect(renderSimInjectLines([{ op: 'replace', path: '/World_Cities/Ironhold', value: { pop: 3 } }])).toBe('World_Cities.Ironhold > {"pop":3}');
    });
    it('NEVER shortens a path: it is the only label the narrator has (the retired owned root printed "0 > …")', () => {
        // A stray second argument — the old owned-root slot — must change nothing.
        expect(renderSimInjectLines([
            { op: 'replace', path: '/Intent/check/0', value: 'target:Mitsuki' },
            { op: 'replace', path: '/Intent/fwb/0', value: 'x' },
        ], '/Intent/check')).toBe('Intent.check.0 > target:Mitsuki\nIntent.fwb.0 > x');
    });
});

describe('simSnapshotDisposition (P0 floor undo record — capture / restore / stack)', () => {
    it('no record on the floor\'s swipe → capture (first PRE write on it)', () => {
        expect(simSnapshotDisposition(undefined, 'loadA:7')).toBe('capture');
        expect(simSnapshotDisposition(null, 'loadA:7')).toBe('capture');
    });
    it('record from ANOTHER attempt → restore (regen/swipe re-fired the turn; the floor holds attempt 1 residue)', () => {
        expect(simSnapshotDisposition({ attempt: 'loadA:6', undo: [] }, 'loadA:7')).toBe('restore');
    });
    it('MUTATION TARGET — the same generation counter in another page load is another attempt', () => {
        expect(simSnapshotDisposition({ attempt: 'loadA:1', undo: [] }, 'loadB:1')).toBe('restore');
    });
    it('record from THIS attempt → stack (a second PRE write in one generation composes, it does not race)', () => {
        // Resetting here would erase the first write — the reason 'stack' exists at all.
        expect(simSnapshotDisposition({ attempt: 'loadA:7', undo: [] }, 'loadA:7')).toBe('stack');
    });
});

describe('the undo record lives on the message it guards (stepSimUndo / readSimUndoRecord / writeSimUndoRecord)', () => {
    const floor = () => ({ State: { note: ['', 'Note'], flag: [false, 'Flag'] } });
    const message = () => ({ is_user: true, mes: 'his line', swipe_id: 0, extra: { reasoning: '' } });
    const noteOp = [{ op: 'replace', path: '/State/note/0', value: 'rolled' }];
    const flagOp = [{ op: 'replace', path: '/State/flag/0', value: true }];
    const throughChatFile = (m) => JSON.parse(JSON.stringify(m));   // what ST saves, and a reload reads back

    it('MUTATION TARGET — a record saved before a page reload still resets the retry after it', () => {
        // attempt 1, page load A: a PRE call writes the note, then a PRE-rail hook writes the flag
        const msg = message();
        const firstAttempt = floor();
        let step = stepSimUndo(readSimUndoRecord(msg, 0).record, 'loadA:1', firstAttempt, noteOp);
        writeSimUndoRecord(msg, 0, step.record);
        step = stepSimUndo(readSimUndoRecord(msg, 0).record, 'loadA:1', firstAttempt, flagOp);
        writeSimUndoRecord(msg, 0, step.record);
        expect(step.reset).toEqual([]);                                     // the second write of one attempt stacks
        // the floor keeps attempt 1's writes; the page reloads and its generation counter starts over
        const reloaded = throughChatFile(msg);
        const residue = { State: { note: ['rolled', 'Note'], flag: [true, 'Flag'] } };
        const retry = stepSimUndo(readSimUndoRecord(reloaded, 0).record, 'loadB:1', residue, noteOp);
        expect([...retry.reset].sort()).toEqual(['/State/flag/0', '/State/note/0']);
        expect(residue.State.flag[0]).toBe(false);                          // a path this attempt does not write is put back too
        expect(residue.State.note[0]).toBe('');
        expect(retry.record.undo.map((u) => u.value)).toEqual(['', false]); // the first write's values still win
    });
    it('MUTATION TARGET — saving keeps the message\'s other extra keys and its other swipes\' records', () => {
        const msg = message();
        msg.extra.reasoning = 'kept';
        writeSimUndoRecord(msg, 1, { attempt: 'loadA:1', undo: [] });
        writeSimUndoRecord(msg, 0, { attempt: 'loadA:2', undo: [] });
        expect(msg.extra.reasoning).toBe('kept');
        expect(readSimUndoRecord(msg, 1).record.attempt).toBe('loadA:1');
        expect(readSimUndoRecord(msg, 0).record.attempt).toBe('loadA:2');
        expect(Object.keys(msg.extra)).toEqual(['reasoning', SIM_UNDO_EXTRA_KEY]);
    });
    it('a message with no record, or no extra at all, reads as none', () => {
        expect(readSimUndoRecord(message(), 0)).toEqual({ record: undefined });
        expect(readSimUndoRecord({ is_user: true, mes: 'x' }, 0)).toEqual({ record: undefined });
        const msg = message();
        writeSimUndoRecord(msg, 0, { attempt: 'loadA:1', undo: [] });
        expect(readSimUndoRecord(msg, 3)).toEqual({ record: undefined });
    });
    it('MUTATION TARGET — what is not an undo record is reported, never used', () => {
        const msg = message();
        msg.extra[SIM_UNDO_EXTRA_KEY] = { 0: { attempt: 5, undo: 'x' } };
        expect(readSimUndoRecord(msg, 0)).toEqual({ isMalformed: true });
        msg.extra[SIM_UNDO_EXTRA_KEY] = 'text';
        expect(readSimUndoRecord(msg, 0)).toEqual({ isMalformed: true });
        msg.extra[SIM_UNDO_EXTRA_KEY] = { 0: { attempt: 'loadA:1', undo: [{ path: 7, had: true }] } };
        expect(readSimUndoRecord(msg, 0)).toEqual({ isMalformed: true });
    });
    it('MUTATION TARGET — a write that fails to land leaves the stored record as it was', () => {
        const stored = { attempt: 'loadA:1', undo: [{ path: '/State/note/0', had: true, value: '' }] };
        const step = stepSimUndo(stored, 'loadB:1', floor(), flagOp);
        expect(stored.attempt).toBe('loadA:1');
        expect(stored.undo).toHaveLength(1);
        expect(step.record.undo).toHaveLength(2);
    });
});

describe('SOURCE GATE — the PRE writer keeps the undo record on the message it writes (extra-llm-calls.js)', () => {
    const source = readFileSync('src/features/small-llm/extra-llm-calls.js', 'utf8').replace(/\r\n/g, '\n');

    it('MUTATION TARGET — the record is read off the message and saved onto it in the state\'s own save', () => {
        expect(source).toContain('const stored = readSimUndoRecord(msg, swipe);');
        expect(source).toMatch(/writeSimUndoRecord\(msg, swipe, record\);\n\s*await saveMessageMvuData\(applied, floorId, \{ writer: 'pre-sim' \}\);/);
    });
    it('MUTATION TARGET — the attempt id carries the page load, not the bare generation counter', () => {
        expect(source).toContain('const attempt = simAttemptId(entryEpoch);');
        expect(source).toContain("const simAttemptId = (epoch) => PAGE_LOAD_ID + ':' + epoch;");
    });
    it('no in-memory record is kept beside it', () => {
        expect(source).not.toMatch(/simFloorSnapshots|pruneSimFloorSnapshots/);
    });
});

describe('the undo record puts back ONLY the paths PRE wrote (recordSimUndo / restoreSimUndo)', () => {
    const floor = () => ({
        Intent: { check: ['', 'Social Check'] },
        Classmate: { Mitsuki: { RelationshipStage: ['Girlfriend', 'Stage'], Affection: [32, 'Aff'], Tags: ['a', 'b'] } },
    });
    const checkOp = (v) => ({ op: 'replace', path: '/Intent/check/0', value: v });

    it('MUTATION TARGET — live 2026-09-29: an edit the player made between attempts survives the retry', () => {
        const undo = recordSimUndo([], floor(), [checkOp('target:Mitsuki;dc:13')]);
        // attempt 1 landed its check; the player then edited the stage in TavernHelper's variable manager
        const next = floor();
        next.Intent.check[0] = 'target:Mitsuki;dc:13';
        next.Classmate.Mitsuki.RelationshipStage[0] = 'Friend';
        const reset = restoreSimUndo(next, undo);
        expect(reset).toEqual(['/Intent/check/0']);
        expect(next.Intent.check[0]).toBe('');                                   // PRE's own write is put back
        expect(next.Classmate.Mitsuki.RelationshipStage[0]).toBe('Friend');    // the edit is not PRE's to reset
    });
    it('the first write wins: a later attempt never re-records a path from its own residue', () => {
        const undo = recordSimUndo([], floor(), [checkOp('first')]);
        const dirty = floor();
        dirty.Intent.check[0] = 'first';
        recordSimUndo(undo, dirty, [checkOp('second')]);
        expect(undo).toHaveLength(1);
        expect(undo[0].value).toBe('');
    });
    it('a path that did not exist is removed again', () => {
        const undo = recordSimUndo([], floor(), [{ op: 'add', path: '/Intent/fresh', value: 1 }]);
        const next = floor();
        next.Intent.fresh = 1;
        restoreSimUndo(next, undo);
        expect('fresh' in next.Intent).toBe(false);
    });
    it('add/remove into an array record the WHOLE array (an index names a different item after a shift)', () => {
        const before = floor();
        const undo = recordSimUndo([], before, [{ op: 'add', path: '/Classmate/Mitsuki/Tags/0', value: 'z' }]);
        expect(undo[0].path).toBe('/Classmate/Mitsuki/Tags');
        const next = floor();
        next.Classmate.Mitsuki.Tags.unshift('z');
        restoreSimUndo(next, undo);
        expect(next.Classmate.Mitsuki.Tags).toEqual(['a', 'b']);
    });
    it('a replace at an index records just that element (an MVU tuple value)', () => {
        const undo = recordSimUndo([], floor(), [checkOp('x')]);
        expect(undo[0].path).toBe('/Intent/check/0');
    });
    it('nested records: the older one wins whichever of parent and child came first', () => {
        const pristine = floor();
        // child first, then (after the child was written) the parent
        const undoA = recordSimUndo([], pristine, [{ op: 'replace', path: '/Classmate/Mitsuki/Affection/0', value: 40 }]);
        const mid = floor(); mid.Classmate.Mitsuki.Affection[0] = 40;
        recordSimUndo(undoA, mid, [{ op: 'replace', path: '/Classmate/Mitsuki', value: {} }]);
        const endA = { Intent: floor().Intent, Classmate: { Mitsuki: {} } };
        restoreSimUndo(endA, undoA);
        expect(endA.Classmate.Mitsuki).toEqual(floor().Classmate.Mitsuki);
        // parent first, then the child
        const undoB = recordSimUndo([], pristine, [{ op: 'replace', path: '/Classmate/Mitsuki', value: { Affection: [1, 'Aff'] } }]);
        const midB = { Intent: floor().Intent, Classmate: { Mitsuki: { Affection: [1, 'Aff'] } } };
        recordSimUndo(undoB, midB, [{ op: 'replace', path: '/Classmate/Mitsuki/Affection/0', value: 2 }]);
        const endB = { Intent: floor().Intent, Classmate: { Mitsuki: { Affection: [2, 'Aff'] } } };
        restoreSimUndo(endB, undoB);
        expect(endB.Classmate.Mitsuki).toEqual(floor().Classmate.Mitsuki);
    });
    it('a prototype-plumbing path is never written', () => {
        const undo = [{ path: '/__proto__/polluted', had: true, value: 1 }];
        restoreSimUndo({}, undo);
        expect(({}).polluted).toBeUndefined();
    });
});


// ── §9a.2 park disposition — the drop guards a live session almost never reaches ──
// Extracted from applySimParks precisely so these branches are reachable: the interceptor's entry
// clear wipes a stranded park first in every hand-stageable scenario (live 2026-08-03), so all three
// drop verdicts below were "never executed against a real event" until they lived here.
describe('simPreApplyDisposition (§4.1 PRE-time apply fence — D5 inverted polarity)', () => {
    const user = () => ({ is_user: true });
    const ai = () => ({ is_user: false });
    // Canonical shape: [AI greeting, USER floor] — the write target is the LAST user floor.
    const base = { entryEpoch: 7, currentEpoch: 7, generationStopped: false, chat: [ai(), user()], expectedUserIndex: 1 };
    const verdict = (over) => simPreApplyDisposition({ ...base, ...over });

    it('applies when nothing moved during the ~2s PRE call', () => {
        expect(verdict({})).toBe('apply');
    });

    it('a STOPPED generation outranks everything else — the log must name the real cause', () => {
        expect(verdict({ generationStopped: true })).toBe('drop-stopped');
        expect(verdict({ generationStopped: true, currentEpoch: 99, chat: [] })).toBe('drop-stopped');
    });

    it('a STALE epoch drops — a newer generation started under the call', () => {
        expect(verdict({ currentEpoch: 8 })).toBe('drop-stale-epoch');
        expect(verdict({ entryEpoch: 6 })).toBe('drop-stale-epoch');
    });

    it('REQUIRES a user floor — the exact inversion of the old drop-no-target', () => {
        expect(verdict({ chat: [], expectedUserIndex: 0 })).toBe('drop-no-user-floor');       // deleted
        expect(verdict({ chat: [ai(), ai()], expectedUserIndex: 1 })).toBe('drop-no-user-floor');  // replaced by an AI floor
        expect(verdict({ chat: null })).toBe('drop-no-user-floor');
    });

    it('drops when the captured index is no longer the LAST user floor (turn advanced mid-call)', () => {
        // A new user message landed while the call ran — writing to the OLD floor would edit history.
        expect(verdict({ chat: [ai(), user(), ai(), user()], expectedUserIndex: 1 })).toBe('drop-swiped');
    });

    it('a later AI floor does NOT fault it — the user floor is still the last USER floor', () => {
        // Mid-generation the reply floor may already exist below us; that is the normal timeline.
        expect(verdict({ chat: [ai(), user(), ai()], expectedUserIndex: 1 })).toBe('apply');
    });

    it('only ever returns a known verdict', () => {
        const known = ['apply', 'drop-stopped', 'drop-stale-epoch', 'drop-no-user-floor', 'drop-swiped'];
        for (const over of [{}, { generationStopped: true }, { currentEpoch: 0 }, { chat: [] },
            { chat: [ai(), user(), ai(), user()], expectedUserIndex: 1 }]) {
            expect(known).toContain(verdict(over));
        }
    });
});

// The card's PRE pattern, as School v4 actually ships it: output pinned to a JSON verdict plus an
// OPTIONAL <JSONPatch>. Compiled with flag 's' (not 'm'), so `$` is end-of-STRING — which is what
// makes one stray token anywhere fatal to the whole output.
const SCHOOL_PRE_REGEX = String.raw`^\s*\{[\s\S]*\}\s*(?:<JSONPatch>[\s\S]*</JSONPatch>\s*)?$`;
const VERDICT = '{"check":{"type":"Flirt","target":"Mitsuki","fires":true}}';
const CHECK_OP = { op: 'replace', path: '/Intent/check/0', value: 'target:Mitsuki;rawdie:14' };
const CHECK_BLOCK = `<JSONPatch>${JSON.stringify([CHECK_OP])}</JSONPatch>`;

describe('decideOutputCheck — ONE verdict, so PRE and POST cannot drift on what a failure means', () => {
    it('no pattern configured / nothing to check → the text passes untouched', () => {
        expect(decideOutputCheck('anything at all', '')).toEqual({ text: 'anything at all', dropped: false, invalid: false });
        expect(decideOutputCheck('   ', SCHOOL_PRE_REGEX)).toEqual({ text: '   ', dropped: false, invalid: false });
    });
    it('a matching text passes; a non-matching one is dropped to empty', () => {
        expect(decideOutputCheck(VERDICT, SCHOOL_PRE_REGEX).dropped).toBe(false);
        const bad = decideOutputCheck(VERDICT + '\nNote: none.', SCHOOL_PRE_REGEX);
        expect(bad.dropped).toBe(true);
        expect(bad.text).toBe('');
    });
    // A config error must never silently discard good output — the output is KEPT and the caller warns.
    it('an INVALID pattern degrades to "no check", keeping the output', () => {
        const r = decideOutputCheck(VERDICT, '([unclosed');
        expect(r).toEqual({ text: VERDICT, dropped: false, invalid: true });
    });
});

describe('splitAndCheckSimOutput (F1) — the patch half and the prose half fail INDEPENDENTLY', () => {
    // Every one of these is a real thing a model does, and every one of them used to cost the turn
    // its state even though the patch beside it was perfectly well-formed.
    const strays = [
        ['a leading preamble', `Here is the classification:\n${VERDICT}\n${CHECK_BLOCK}`],
        ['a markdown code fence', '```json\n' + VERDICT + '\n```\n' + CHECK_BLOCK],
        ['a <think> block', `<think>she seems receptive</think>\n${VERDICT}\n${CHECK_BLOCK}`],
        ['a trailing note', `${VERDICT}\n${CHECK_BLOCK}\nNote: no FWB proposed.`],
        ['a trailing period', `${VERDICT}\n${CHECK_BLOCK}.`],
    ];
    it('a stray token costs the PROSE injection and the patch still survives', () => {
        for (const [what, raw] of strays) {
            const r = splitAndCheckSimOutput(raw, SCHOOL_PRE_REGEX);
            expect(r.proseDropped, what).toBe(true);
            expect(r.prose, what).toBe('');
            expect(r.patchTexts, what).toEqual([CHECK_BLOCK]);      // the dice report LIVES
            expect(validateSimPatchOutput(r.patchTexts[0]).ops, what).toEqual([CHECK_OP]);
        }
    });
    it('a clean contract output keeps BOTH halves', () => {
        const r = splitAndCheckSimOutput(`${VERDICT}\n${CHECK_BLOCK}`, SCHOOL_PRE_REGEX);
        expect(r.proseDropped).toBe(false);
        expect(r.prose).toBe(VERDICT);
        expect(r.patchTexts).toEqual([CHECK_BLOCK]);
    });
    // The mirror case: the prose is fine and the PATCH is the broken half. The verdict the narrator
    // reads must not be lost because the state half failed.
    it('an unusable patch costs the state and the prose still injects', () => {
        const truncated = '<JSONPatch>[{"op":"replace","path":"/Intent/check/0","value":"burned</JSONPatch>';
        const r = splitAndCheckSimOutput(`${VERDICT}\n${truncated}`, SCHOOL_PRE_REGEX);
        expect(r.proseDropped).toBe(false);
        expect(r.prose).toBe(VERDICT);
        expect(validateSimPatchOutput(r.patchTexts[0]).ok).toBe(false);
    });
    it('the check sees the PROSE, never the raw output — a patch block cannot fail the prose pattern', () => {
        // Proof the split really happens first: this regex forbids the string "JSONPatch" outright,
        // so it can only pass if what was tested had the blocks already removed.
        const noPatchAllowed = String.raw`^\{[\s\S]*\}$`;
        const r = splitAndCheckSimOutput(`${VERDICT}\n${CHECK_BLOCK}`, noPatchAllowed);
        expect(r.proseDropped).toBe(false);
        expect(r.prose).toBe(VERDICT);
    });
});

describe('splitSimOutput (T1 mixed output — verdict + EVERY <JSONPatch>)', () => {
    it('mixed output: the patch block out, the verdict remainder kept', () => {
        const { patchTexts, remainder } = splitSimOutput('{"check":{"type":"none"}}\n<JSONPatch>[{"op":"replace","path":"/X/0","value":1}]</JSONPatch>');
        expect(patchTexts).toEqual(['<JSONPatch>[{"op":"replace","path":"/X/0","value":1}]</JSONPatch>']);
        expect(remainder).toBe('{"check":{"type":"none"}}');
    });
    // One call's system block is every routed lorebook entry concatenated, so several blocks in one
    // output is a SUPPORTED shape — each entry may ask for its own patch. Taking only the first
    // dropped every later entry's state AND left its raw ops in the remainder, where they were
    // injected into the narrator's prompt verbatim (I3).
    it('EVERY block is returned, in order, and NONE is left in the remainder', () => {
        const a = '<JSONPatch>[{"op":"replace","path":"/Intent/check/0","value":"rawdie:14"}]</JSONPatch>';
        const b = '<JSONPatch>[{"op":"add","path":"/Weather/Today","value":"rain"}]</JSONPatch>';
        const { patchTexts, remainder } = splitSimOutput(`{"check":{"fires":true}}\n${a}\n${b}`);
        expect(patchTexts).toEqual([a, b]);
        expect(remainder).toBe('{"check":{"fires":true}}');
        expect(remainder).not.toMatch(/JSONPatch/);          // the leak this closes
    });
    it('patch-only output: remainder empty — the legacy sim shape is unchanged', () => {
        const { patchTexts, remainder } = splitSimOutput('<JSONPatch>[]</JSONPatch>');
        expect(patchTexts).toEqual(['<JSONPatch>[]</JSONPatch>']);
        expect(remainder).toBe('');
    });
    it('an <UpdateVariable> wrapper is stripped from the remainder, not kept as junk', () => {
        const { patchTexts, remainder } = splitSimOutput('<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>');
        expect(patchTexts).toEqual(['<JSONPatch>[]</JSONPatch>']);
        expect(remainder).toBe('');
    });
    it('naked JSON ARRAY = the patch (legacy tolerance)', () => {
        const { patchTexts, remainder } = splitSimOutput('[{"op":"replace","path":"/X/0","value":1}]');
        expect(patchTexts).toEqual(['[{"op":"replace","path":"/X/0","value":1}]']);
        expect(remainder).toBe('');
    });
    it('a JSON OBJECT (the verdict) is NEVER eaten by the array fallback', () => {
        const { patchTexts, remainder } = splitSimOutput('{"check":{"type":"Flirt"}}');
        expect(patchTexts).toEqual([]);
        expect(remainder).toBe('{"check":{"type":"Flirt"}}');
    });
    it('text that merely opens with "[" but is not JSON → no patch, remainder kept', () => {
        const { patchTexts, remainder } = splitSimOutput('[PRE] some stray label');
        expect(patchTexts).toEqual([]);
        expect(remainder).toBe('[PRE] some stray label');
    });
});

// ── decideResCarry — which <RES_Variable> POST carries, and whether it writes at all ──────────
// The regression this guards is a SILENT one: POST captured the RES block before its LLM calls and
// decided from that stale capture afterwards, so a block that staged DURING the calls was dropped
// with the turn. Live loss 2026-08-09 (msg 4 — first resolve after a card import, cold engine).
describe('isTurnSettledAtPostEnd — the turn\'s end refreshes the stat box only from a final state', () => {
    it('MUTATION TARGET — POST calls ran on a live turn: settled', () => {
        expect(isTurnSettledAtPostEnd({ didPostCallsRun: true, didAwaitTurnResolver: false, isTurnLive: true })).toBe(true);
    });

    it('MUTATION TARGET — no call, but the pass waited for RES1\'s whole run on a live turn: settled', () => {
        expect(isTurnSettledAtPostEnd({ didPostCallsRun: false, didAwaitTurnResolver: true, isTurnLive: true })).toBe(true);
    });

    it('MUTATION TARGET — no call and no resolver: the pass ends before MVU has stored narrate\'s parse, so not settled', () => {
        expect(isTurnSettledAtPostEnd({ didPostCallsRun: false, didAwaitTurnResolver: false, isTurnLive: true })).toBe(false);
    });

    it('MUTATION TARGET — a turn that advanced or swiped away is never settled, whatever the pass waited for', () => {
        expect(isTurnSettledAtPostEnd({ didPostCallsRun: true, didAwaitTurnResolver: true, isTurnLive: false })).toBe(false);
    });
});

describe('decideResCarry (POST\'s RES_Variable carry decision)', () => {
    const RES = '<RES_Variable>\n[{"op":"replace","path":"/Mainchar/Cha/0","value":51}]\n</RES_Variable>';

    it('carries the gate\'s block when the gate saw it — and does not call that late', () => {
        const d = decideResCarry(RES, RES, 0);
        expect(d.block).toBe(RES);
        expect(d.late).toBe(false);
        expect(d.label).toBe('carried');
        expect(d.willWrite).toBe(true);
    });

    it('THE REGRESSION: gate empty + staged by write time ⇒ carried, flagged late, and it WRITES', () => {
        const d = decideResCarry('', RES, 0);       // exactly msg 4: 0 POST blocks, RES arrived late
        expect(d.block).toBe(RES);                  // the old code carried '' here…
        expect(d.willWrite).toBe(true);             // …so this was false and the audit died
        expect(d.late).toBe(true);
        expect(d.label).toBe('carried (arrived late)');
    });

    it('reports NOTHING to write when neither a POST block nor a RES block exists', () => {
        const d = decideResCarry('', '', 0);
        expect(d.willWrite).toBe(false);
        expect(d.label).toBe('none');
        expect(d.late).toBe(false);
    });

    it('still writes for POST\'s own blocks when RES staged nothing (a legit no-engine turn)', () => {
        const d = decideResCarry('', '', 2);
        expect(d.willWrite).toBe(true);
        expect(d.block).toBe('');
        expect(d.label).toBe('none');               // must not imply an audit block was carried
    });

    it('a gate hit is never relabelled late, even when the marker still reads the same block', () => {
        expect(decideResCarry(RES, '', 1).late).toBe(false);
        expect(decideResCarry(RES, RES, 0).refreshed).toBe(false);          // same block ⇒ nothing was superseded
    });

    // THE LIVE BUG (2026-08-22, msg 6). RES resolved the turn TWICE as the narrator's patch landed
    // progressively — the first pass saw only PRE's check, the second saw the clock report and the spine
    // step too — and each pass restaged. Preferring the GATE published the first pass's half-finished
    // audit (ClocklessStreak 1, no clock op) while the marker held the complete one. The fresher read
    // is the same turn, further along; it can never be a different turn's (readResStaged filters to
    // {mid,swipe}, and a cross-generation corpse is dropped at generation start).
    it('prefers the WRITE-TIME marker over the gate capture when RES resolved again in between', () => {
        const complete = '<RES_Variable>\n[{"op":"replace","path":"/World/Time/0","value":"08:00"}]\n</RES_Variable>';
        const d = decideResCarry(RES, complete, 0);
        expect(d.block).toBe(complete);
        expect(d.refreshed).toBe(true);
        expect(d.late).toBe(false);                                          // the gate DID hit — it was just superseded
        expect(d.label).toMatch(/refreshed at write time/);
    });

    it('falls back to the gate capture when the write-time read is empty', () => {
        const d = decideResCarry(RES, '', 0);
        expect(d.block).toBe(RES);
        expect(d.refreshed).toBe(false);
        expect(d.label).toBe('carried');
    });

    it('degrades on null/undefined instead of throwing (both reads are plain property access)', () => {
        expect(decideResCarry(null, undefined, undefined).willWrite).toBe(false);
        expect(decideResCarry(undefined, null, 0).block).toBe('');
    });
});

describe('placePostRelayBlock — WHERE the relay receipt goes in the finished message (P7)', () => {
    const CLOSE = `</${TURN_AUDIT_TAG}>`;   // what the POST caller passes
    const TAIL = REPLY_TAIL_ANCHORS;          // …and the reply's tail: the engine's end text, else the menu placeholder
    const RELAY = ['<RES_POST_Variable>', '[…]', '</RES_POST_Variable>'].join('\n');
    const full = [
        '<gametxt>prose</gametxt>',
        '<POSTUpdateVariable>ops</POSTUpdateVariable>',
        ['<RES_Variable>', '[…]', '</RES_Variable>'].join('\n'),
        '<choices>…</choices>',
        MENU_PLACEHOLDER,
    ].join('\n\n');

    it('lands immediately after the RES1 receipt — the two audit blocks are one story', () => {
        const out = placePostRelayBlock(full, RELAY, CLOSE, TAIL);
        expect(out.indexOf(RELAY)).toBeGreaterThan(out.indexOf('</RES_Variable>'));
        expect(out.indexOf(RELAY)).toBeLessThan(out.indexOf('<choices>'));
    });

    it('NEVER below the stat menu — the live bug: stranded there it re-flows every block above it', () => {
        const out = placePostRelayBlock(full, RELAY, CLOSE, TAIL);
        expect(out.indexOf(RELAY)).toBeLessThan(out.indexOf(MENU_PLACEHOLDER));
    });

    it('falls back to just ABOVE the menu when there is no RES1 block to anchor to', () => {
        const noRes = '<gametxt>prose</gametxt>\n\n' + MENU_PLACEHOLDER;
        const out = placePostRelayBlock(noRes, RELAY, CLOSE, TAIL);
        expect(out).toBe('<gametxt>prose</gametxt>\n\n' + RELAY + '\n\n' + MENU_PLACEHOLDER);
    });

    it('MUTATION TARGET — with the engine\'s end text and no RES1 block, it lands above the end text, which stays directly above the menu', () => {
        const withEnd = '<gametxt>prose</gametxt>\n\n<EndText>END</EndText>\n\n' + MENU_PLACEHOLDER;
        expect(placePostRelayBlock(withEnd, RELAY, CLOSE, TAIL))
            .toBe('<gametxt>prose</gametxt>\n\n' + RELAY + '\n\n<EndText>END</EndText>\n\n' + MENU_PLACEHOLDER);
    });

    it('appends only when no anchor exists — correct there, not a stranding', () => {
        const bare = '<gametxt>prose</gametxt>';
        expect(placePostRelayBlock(bare, RELAY, CLOSE, TAIL)).toBe(bare + '\n\n' + RELAY);
    });

    it('is IDEMPOTENT: a re-run never stacks a second copy of the same receipt', () => {
        const once = placePostRelayBlock(full, RELAY, CLOSE, TAIL);
        expect(placePostRelayBlock(once, RELAY, CLOSE, TAIL)).toBe(once);
    });

    it('anchors on the closing tag it is GIVEN — the pure half spells no tag of its own', () => {
        const other = 'a\n\n<Ledger>x</Ledger>\n\n' + MENU_PLACEHOLDER;
        const out = placePostRelayBlock(other, RELAY, '</Ledger>', TAIL);
        expect(out.indexOf(RELAY)).toBeGreaterThan(out.indexOf('</Ledger>'));
        expect(out.indexOf(RELAY)).toBeLessThan(out.indexOf(MENU_PLACEHOLDER));
    });

    it('anchors on the tail it is GIVEN — the pure half spells no marker of its own either', () => {
        const ownMenu = 'a\n\n<MyMenu/>';
        const out = placePostRelayBlock(ownMenu, RELAY, CLOSE, ['<MyMenu/>']);
        expect(out).toBe('a\n\n' + RELAY + '\n\n<MyMenu/>');
        // Not given one, it knows none — the stat menu's marker is only text then, and the receipt appends.
        const noRes = '<gametxt>prose</gametxt>\n\n' + MENU_PLACEHOLDER;
        expect(placePostRelayBlock(noRes, RELAY, CLOSE)).toBe(noRes + '\n\n' + RELAY);
    });

    it('an empty block changes nothing, and junk input does not throw', () => {
        expect(placePostRelayBlock(full, '', CLOSE, TAIL)).toBe(full);
        expect(placePostRelayBlock(null, RELAY, CLOSE, TAIL)).toBe(RELAY);
        expect(() => placePostRelayBlock(undefined, undefined)).not.toThrow();
    });
});

describe('splitAndCheckPostOutput (F1 for POST) — the block survives a failed prose check', () => {
    // The pattern someone writes the moment a POST model starts adding preambles. Setting it used to be
    // the thing that broke POST: the check ran on the RAW output, so the block died with the prose.
    const POST_REGEX = '^\\s*<UpdateVariable>';
    const BLOCK = '<UpdateVariable>\n<JSONPatch>[{"op":"set","path":"/A","value":1}]</JSONPatch>\n</UpdateVariable>';

    it('a clean output passes and the block is found', () => {
        const r = splitAndCheckPostOutput(BLOCK, POST_REGEX);
        expect(r.proseDropped).toBe(false);
        expect(r.blocks).toEqual([BLOCK]);
    });

    // THE DEFECT THIS EXISTS FOR. A dropped POST block loses the whole turn's state write, and it looks
    // exactly like "the model had nothing to record" — the failure is invisible at the point it happens.
    it('a preamble drops the PROSE and KEEPS the block', () => {
        const r = splitAndCheckPostOutput('Sure! Here is the update:\n' + BLOCK, POST_REGEX);
        expect(r.proseDropped).toBe(true);
        expect(r.blocks).toEqual([BLOCK]);
    });

    it('a code fence, a <think>, and a trailing note each keep the block', () => {
        const strays = [
            '```json\n' + BLOCK,
            '<think>reasoning</think>\n' + BLOCK,
            BLOCK + '\nNote: done.',
        ];
        for (const raw of strays) {
            expect(splitAndCheckPostOutput(raw, POST_REGEX).blocks).toEqual([BLOCK]);
        }
    });

    it('keeps SEVERAL blocks — a shared POST call carries more than one author\'s', () => {
        const second = '<UpdateVariable>\n<JSONPatch>[{"op":"set","path":"/B","value":2}]</JSONPatch>\n</UpdateVariable>';
        const r = splitAndCheckPostOutput('junk\n' + BLOCK + '\n' + second, POST_REGEX);
        expect(r.blocks).toHaveLength(2);
    });

    // `[]` is the contract's deliberate quiet-turn answer. extractUpdateVariableBlocks drops it BY
    // DESIGN; this split must not, or classifyPostOutput can no longer tell a quiet turn apart from a
    // model that broke the contract entirely.
    it('KEEPS an empty patch block, unlike extractUpdateVariableBlocks', () => {
        const empty = '<UpdateVariable>\n<JSONPatch>[]</JSONPatch>\n</UpdateVariable>';
        expect(splitAndCheckPostOutput('junk\n' + empty, POST_REGEX).blocks).toEqual([empty]);
        expect(extractUpdateVariableBlocks('junk\n' + empty)).toEqual([]);
    });

    it('takes the renamed POSTUpdateVariable wrapper too', () => {
        const relayed = '<POSTUpdateVariable>\n<JSONPatch>[{"op":"set","path":"/A","value":1}]</JSONPatch>\n</POSTUpdateVariable>';
        expect(splitAndCheckPostOutput('junk\n' + relayed, POST_REGEX).blocks).toEqual([relayed]);
    });

    it('no pattern configured ⇒ nothing is ever dropped', () => {
        expect(splitAndCheckPostOutput('anything at all\n' + BLOCK, '').proseDropped).toBe(false);
    });

    it('an INVALID pattern degrades to no-check and keeps the output', () => {
        const r = splitAndCheckPostOutput('prose\n' + BLOCK, '/([unclosed/');
        expect(r.regexInvalid).toBe(true);
        expect(r.proseDropped).toBe(false);
    });

    it('garbage with NO block still drops — there is nothing worth keeping', () => {
        const r = splitAndCheckPostOutput('I could not do that.', POST_REGEX);
        expect(r.proseDropped).toBe(true);
        expect(r.blocks).toEqual([]);
    });
});

describe('splitAndCheckPostOutput — the check sees the PROSE, never the raw output', () => {
    // These two exist because the obvious tests do NOT discriminate: for a preamble, the raw string and
    // the stripped prose BOTH fail, so a version that checked the raw output passed every one of them.
    // (Found by mutation — `const prose = s;` survived the whole suite.) Each case below is one where
    // the two answers DIFFER, which is the only way to pin which text was judged.
    const BLOCK = '<UpdateVariable>\n<JSONPatch>[{"op":"set","path":"/A","value":1}]</JSONPatch>\n</UpdateVariable>';

    it('raw PASSES but the prose FAILS ⇒ dropped (a trailing note after a well-formed block)', () => {
        const raw = BLOCK + '\nNote: done.';
        // '^\s*<UpdateVariable>' matches `raw` (it starts with the block) but not the prose 'Note: done.'
        const r = splitAndCheckPostOutput(raw, '^\\s*<UpdateVariable>');
        expect(r.proseDropped).toBe(true);
        expect(r.blocks).toEqual([BLOCK]);
    });

    it('raw FAILS but the prose PASSES ⇒ kept (the card describes its PROSE, not its payload)', () => {
        const raw = BLOCK + '\nRecorded.';
        // '^Recorded\.$' cannot match `raw` (it begins with the block) but matches the prose exactly.
        const r = splitAndCheckPostOutput(raw, '^Recorded\\.$');
        expect(r.proseDropped).toBe(false);
        expect(r.prose).toBe('Recorded.');
    });
});

describe('postTargetDisposition — which reply POST records, or that it must not run', () => {
    const ai = (mes = 'a reply') => ({ mes, is_user: false });
    const user = () => ({ mes: 'hi', is_user: true });
    const chat = () => [user(), ai('one'), user(), ai('two')];

    it('the named message is the target — the normal path', () => {
        expect(postTargetDisposition(3, chat())).toEqual({ verdict: 'target', mesId: 3 });
        expect(postTargetDisposition(1, chat())).toEqual({ verdict: 'target', mesId: 1 });
    });

    it('no id named falls to the last message — the ONE case that legitimately does', () => {
        expect(postTargetDisposition(null, chat())).toEqual({ verdict: 'last', mesId: 3 });
        expect(postTargetDisposition(undefined, chat())).toEqual({ verdict: 'last', mesId: 3 });
    });

    // THE LIVE BUG, 2026-08-27. A chat reload landed mid-stream and truncated ST's streaming
    // placeholder away; ST's onErrorStreaming emits MESSAGE_RECEIVED for the dead stream anyway.
    // The old code read `chat[messageId] ? messageId : chat.length - 1` and retargeted onto the
    // PREVIOUS reply, spending a real LLM call and re-writing record ops it had already applied.
    it('a VANISHED message refuses — it must NEVER retarget onto the last message', () => {
        const c = chat();
        expect(postTargetDisposition(4, c)).toEqual({ verdict: 'refuse-vanished', mesId: -1 });
        expect(postTargetDisposition(99, c)).toEqual({ verdict: 'refuse-vanished', mesId: -1 });
        // the mutation this test exists to kill: falling back would answer mesId 3
        expect(postTargetDisposition(4, c).mesId).not.toBe(c.length - 1);
    });

    it('a hole left where the named message was refuses too — an index that exists is not a message', () => {
        const c = chat();
        delete c[3];
        expect(postTargetDisposition(3, c).verdict).toBe('refuse-vanished');
    });

    it('a user floor is never recorded, named or last', () => {
        expect(postTargetDisposition(2, chat()).verdict).toBe('refuse-user-message');
        expect(postTargetDisposition(null, [user()]).verdict).toBe('refuse-user-message');
    });

    it('no chat at all is its own verdict — "could not look" is not "nothing to record"', () => {
        for (const bad of [null, undefined, [], 'nope']) {
            expect(postTargetDisposition(0, bad).verdict).toBe('refuse-no-chat');
        }
    });

    it('every refusal answers mesId -1 — no caller can read a usable floor out of a refusal', () => {
        for (const r of [postTargetDisposition(9, chat()), postTargetDisposition(2, chat()), postTargetDisposition(0, [])]) {
            expect(r.mesId).toBe(-1);
        }
    });
});


describe('placePostRelayBlock — the block is model text, so it is never read as $-syntax (F6)', () => {
    // `String.replace` expands $&, $`, $' and $1 in a replacement STRING even when the search is a
    // plain string. The block comes from a model/engine, so a stray `$&` would have spliced a copy
    // of the anchor tag into the player's message.
    const RES = '<RES_Variable>x</RES_Variable>';

    it('MUTATION TARGET — $& in the block stays literal at the RES anchor', () => {
        const out = placePostRelayBlock('prose\n\n' + RES, '<R>cost $& and $`100</R>', `</${TURN_AUDIT_TAG}>`);
        expect(out).toContain('<R>cost $& and $`100</R>');
        expect(out.match(/<\/RES_Variable>/g)).toHaveLength(1);
    });

    it('MUTATION TARGET — $& in the block stays literal at the menu anchor', () => {
        const out = placePostRelayBlock('prose\n\n<StatusPlaceHolderImpl/>', '<R>$&$&</R>', '', REPLY_TAIL_ANCHORS);
        expect(out).toBe('prose\n\n<R>$&$&</R>\n\n<StatusPlaceHolderImpl/>');
    });

    it("$' and a group reference are literal too, on the append path", () => {
        const out = placePostRelayBlock('prose only', "<R>$'$1</R>", '');
        expect(out).toBe("prose only\n\n<R>$'$1</R>");
    });
});

// A call with no routed lorebook entry has no contract — the phase must skip it rather than spend a
// request and then blame the model for answering nothing usable.
describe('callDispatchDisposition', () => {
    it('runs a call whose block carries a contract', () => {
        expect(callDispatchDisposition({ systemBlock: '# record the outfits' })).toBe('run');
    });

    it('MUTATION TARGET — an empty block is no-contract, so the call is never dispatched', () => {
        expect(callDispatchDisposition({ systemBlock: '' })).toBe('no-contract');
    });

    it('whitespace-only is no-contract too — routed nothing, indented', () => {
        expect(callDispatchDisposition({ systemBlock: ' ' + String.fromCharCode(9, 10, 13) + ' ' })).toBe('no-contract');
    });

    it('a missing block is no-contract, never a crash', () => {
        expect(callDispatchDisposition({})).toBe('no-contract');
        expect(callDispatchDisposition({ systemBlock: null })).toBe('no-contract');
        expect(callDispatchDisposition()).toBe('no-contract');
    });

    it('a block that is only a comment still counts as a contract — the card meant to send it', () => {
        expect(callDispatchDisposition({ systemBlock: '<!-- deliberately quiet -->' })).toBe('run');
    });
});


// The routing check: entries routed to a call that will not run. The lorebook entry's own `enabled` never
// matters — a PRE/POST entry is often disabled so the narrator never reads it.
describe('unrunnableRoutedCalls — routed entries whose call will not run', () => {
    const PRE = { name: 'PRE', enabled: true, profileId: 'p1', phase: 'pre' };
    const POST = { name: 'POST', enabled: true, profileId: 'p2', phase: 'post' };
    const entries = [
        { comment: '[PRE] Reply_Request', enabled: true },
        { comment: '[POST] Reply_Request', enabled: false },
        { comment: '[POST] Story_Analysis', enabled: true },
        { comment: '[llmshare] Classmate_Roster', enabled: true },
        { comment: 'Worldview', enabled: true },
    ];
    const check = (fields) => unrunnableRoutedCalls({ isExtraCallsOn: true, calls: [PRE, POST], groups: [], entries, ...fields });

    it('every call running: nothing to report', () => {
        expect(check({})).toEqual([]);
    });

    it('MUTATION TARGET — a switched-off call with routed entries is reported, disabled entries counted too', () => {
        expect(check({ calls: [PRE, { ...POST, enabled: false }] })).toEqual([
            { name: 'POST', isGroup: false, reason: 'disabled', entryNames: ['[POST] Reply_Request', '[POST] Story_Analysis'] },
        ]);
    });

    it('MUTATION TARGET — a call that is on without a connection profile is its own reason', () => {
        expect(check({ calls: [{ ...PRE, profileId: '' }, POST] })).toEqual([
            { name: 'PRE', isGroup: false, reason: 'no-connection', entryNames: ['[PRE] Reply_Request'] },
        ]);
    });

    it('MUTATION TARGET — with the Extra LLM Calls switch off, every call with routed entries is reported as that', () => {
        const findings = unrunnableRoutedCalls({ isExtraCallsOn: false, calls: [PRE, POST], groups: [], entries });
        expect(findings.map((f) => [f.name, f.reason])).toEqual([['PRE', 'extra-calls-off'], ['POST', 'extra-calls-off']]);
    });

    it('a call with nothing routed to it is never reported, whatever its switch', () => {
        expect(check({ calls: [PRE, POST, { name: 'Spare', enabled: false, profileId: '' }] })).toEqual([]);
    });

    it('MUTATION TARGET — a group counts only when none of its calls runs', () => {
        const groups = [{ tag: 'llmshare', members: ['PRE', 'POST'] }];
        expect(check({ groups, calls: [PRE, { ...POST, enabled: false }] }).filter((f) => f.isGroup)).toEqual([]);
        expect(check({ groups, calls: [{ ...PRE, enabled: false }, { ...POST, enabled: false }] }).filter((f) => f.isGroup)).toEqual([
            { name: 'llmshare', isGroup: true, reason: 'no-member-runs', entryNames: ['[llmshare] Classmate_Roster'] },
        ]);
        expect(unrunnableRoutedCalls({ isExtraCallsOn: false, calls: [PRE, POST], groups, entries }).filter((f) => f.isGroup)
            .map((f) => f.reason)).toEqual(['extra-calls-off']);
    });

    it('survives being called with nothing at all', () => {
        expect(unrunnableRoutedCalls()).toEqual([]);
        expect(unrunnableRoutedCalls({ isExtraCallsOn: true, calls: null, groups: null, entries: null })).toEqual([]);
    });
});

describe('describeNoTextAnswer — what an answer with no text held', () => {
    // Live 2026-10-25, msg 2628: the POST toast read "returned nothing (timeout/error)", and ST's server log held this.
    const luna = {
        choices: [{ finish_reason: 'stop', native_finish_reason: 'completed', message: { role: 'assistant', content: null, refusal: null, reasoning: null } }],
        usage: { prompt_tokens: 2100, completion_tokens: 125, completion_tokens_details: { reasoning_tokens: 119 } },
    };

    it('MUTATION TARGET — names the finish reason, the native one when it differs, and how much of the output was reasoning', () => {
        expect(describeNoTextAnswer(luna)).toBe('finish_reason "stop" (native: completed) · 125 output token(s), 119 of them reasoning');
    });

    it('MUTATION TARGET — a refusal the provider sent in place of text is quoted', () => {
        const refused = { choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I cannot help with that.' } }], usage: { completion_tokens: 9 } };
        expect(describeNoTextAnswer(refused)).toBe('finish_reason "stop" · refusal "I cannot help with that." · 9 output token(s)');
    });

    it('a native reason equal to the finish reason is not repeated, and no reasoning is not counted', () => {
        const plain = { choices: [{ finish_reason: 'stop', native_finish_reason: 'STOP', message: { content: '' } }], usage: { completion_tokens: 0 } };
        expect(describeNoTextAnswer(plain)).toBe('finish_reason "stop" · 0 output token(s)');
    });

    it('a response with nothing to say says so, and garbage never throws', () => {
        const none = 'the response carries no finish reason and no token counts';
        expect(describeNoTextAnswer({})).toBe(none);
        expect(describeNoTextAnswer(null)).toBe(none);
        expect(describeNoTextAnswer('')).toBe(none);
        expect(describeNoTextAnswer({ usage: { completion_tokens: null } })).toBe(none);
    });
});

describe('emptyResultCause — why a call left its pass nothing to use', () => {
    it('MUTATION TARGET — a call that threw or timed out (null) has failed, never answered with no text', () => {
        expect(emptyResultCause({ raw: null, kept: null })).toBe('failed');
        expect(emptyResultCause({ raw: undefined, kept: '' })).toBe('failed');
    });

    it('MUTATION TARGET — an answer with no text is said as that, whatever the checks kept', () => {
        expect(emptyResultCause({ raw: '', kept: '' })).toBe('no-text');
        expect(emptyResultCause({ raw: '  \n', kept: '' })).toBe('no-text');
    });

    it('MUTATION TARGET — an answer the checks emptied is refused; an empty patch alone is quiet', () => {
        expect(emptyResultCause({ raw: 'garbage prose', kept: '' })).toBe('refused');
        expect(emptyResultCause({ raw: '<JSONPatch>[]</JSONPatch>', kept: '', isQuietPatch: true })).toBe('quiet');
    });

    it('anything kept is no empty result, quiet patch or not', () => {
        expect(emptyResultCause({ raw: 'x', kept: 'x' })).toBe('');
        expect(emptyResultCause({ raw: 'x', kept: 'prose', isQuietPatch: true })).toBe('');
    });
});

describe('carriesOnlyTasks — a call with no duty of its own', () => {
    it('MUTATION TARGET — every routed entry is a task routing entry (a card with no logic engine, live 2026-10-25)', () => {
        expect(carriesOnlyTasks(['[POST] mvu-llm-task:imagegen-charimg'], isTaskRoutingEntryName)).toBe(true);
        expect(carriesOnlyTasks(['[POST] mvu-llm-task:imagegen-charimg', '[POST] mvu-llm-task:imagegen-pictures'], isTaskRoutingEntryName)).toBe(true);
    });

    it('MUTATION TARGET — one entry of the card\'s own gives the call a contract of its own', () => {
        expect(carriesOnlyTasks(['[POST] mvu-llm-task:imagegen-charimg', '[GameLogicPack:school-v4] [POST] Record_Rules'], isTaskRoutingEntryName)).toBe(false);
    });

    it('a call routed nothing, or no predicate, carries no task', () => {
        expect(carriesOnlyTasks([], isTaskRoutingEntryName)).toBe(false);
        expect(carriesOnlyTasks(null, isTaskRoutingEntryName)).toBe(false);
        expect(carriesOnlyTasks(['[POST] mvu-llm-task:x'], null)).toBe(false);
    });
});

describe('sortEmptyResults / describeEmptyResult — who answers for an empty result', () => {
    const row = (label, cause, isTaskOnly = false, detail = '') => ({ label, cause, isTaskOnly, detail });

    it('MUTATION TARGET — an answer with no text from a call carrying only tasks goes to its tasks, not the degraded summary', () => {
        const { degraded, handedToTasks } = sortEmptyResults([row('POST', 'no-text', true)]);
        expect(degraded).toEqual([]);
        expect(handedToTasks.map((r) => r.label)).toEqual(['POST']);
    });

    it('MUTATION TARGET — the same answer from a call with a contract of its own degrades the pass', () => {
        expect(sortEmptyResults([row('POST', 'no-text', false)]).degraded.map((r) => r.label)).toEqual(['POST']);
    });

    it('MUTATION TARGET — a failed call or a refused output degrades the pass even when it carries only tasks', () => {
        expect(sortEmptyResults([row('A', 'failed', true), row('B', 'refused', true)]).degraded.map((r) => r.label)).toEqual(['A', 'B']);
    });

    it('a quiet result and a call that left something are in neither list', () => {
        expect(sortEmptyResults([row('A', 'quiet'), row('B', '')])).toEqual({ degraded: [], handedToTasks: [] });
        expect(sortEmptyResults(null)).toEqual({ degraded: [], handedToTasks: [] });
    });

    it('MUTATION TARGET — each cause in its own words; the detail rides along, except in a toast', () => {
        const detail = 'finish_reason "stop" · 125 output token(s), 119 of them reasoning';
        expect(describeEmptyResult(row('POST', 'no-text', false, detail))).toBe(`POST answered with no text: ${detail}`);
        expect(describeEmptyResult(row('POST', 'no-text', false, detail), { withDetail: false })).toBe('POST answered with no text');
        expect(describeEmptyResult(row('PRE', 'failed'))).toBe('PRE failed or timed out');
        expect(describeEmptyResult(row('PRE', 'refused'))).toBe('PRE left nothing usable after the checks');
    });
});

// The passes live in the host-coupled extra-llm-calls.js, so their load-bearing lines are gated as SOURCE.
describe('SOURCE GATE — each pass names why a call left it nothing (extra-llm-calls.js)', () => {
    const source = readFileSync('src/features/small-llm/extra-llm-calls.js', 'utf8').replace(/\r\n/g, '\n');

    it('MUTATION TARGET — the summary that lumped every cause together is gone from both passes', () => {
        expect(source).not.toContain('produced no usable output');
        expect(source).not.toContain('returned nothing (timeout/error)');
    });

    it('MUTATION TARGET — both passes report through the one summary, PRE with its quiet patches', () => {
        expect(source).toContain("reportEmptyResults('PRE', calls, { rawResults, keptResults: results, taskOnly: preContracts.taskOnly, noTextDetails, quietPatches },");
        expect(source).toContain("reportEmptyResults('POST', calls, { rawResults, keptResults: results, taskOnly: postContracts.taskOnly, noTextDetails },");
    });

    it('MUTATION TARGET — the summary judges each call by what it returned, what was kept and whether it carries only tasks', () => {
        expect(source).toContain('cause: emptyResultCause({ raw: rawResults[i], kept: keptResults[i], isQuietPatch: quietPatches.has(call) }),');
        expect(source).toContain('isTaskOnly: taskOnly.has(call),');
        expect(source).toContain('const { degraded, handedToTasks } = sortEmptyResults(rows);');
        expect(source).toContain('if (!degraded.length) return;');
    });

    it('MUTATION TARGET — PRE keeps what each call returned before the sim loop replaces it, POST before its output check', () => {
        expect(source).toContain('const rawResults = [...results];');
        expect(source).toContain('const rawResults = await runCalls(calls, replyText, runOne, elc.parallel, callScheduleKey);\n        const results = enforcePostOutputChecks(calls, rawResults);');
    });

    it('MUTATION TARGET — only an empty patch with no refusal is quiet', () => {
        expect(source).toMatch(/if \(refusals\) simLog\.warn\(`no usable op survived[^\n]*\n\s*else \{\n\s*quietPatches\.add\(calls\[i\]\);/);
    });

    it('MUTATION TARGET — a call carries only tasks when every entry routed to it is a task routing entry', () => {
        expect(source).toContain('if (carriesOnlyTasks(entryNames, isTaskRoutingEntryName)) taskOnly.add(call);');
    });

    it('MUTATION TARGET — an answer with no text says what it held: to the pass, or as a warning when run ad hoc', () => {
        expect(source).toContain("if (!text.trim()) {\n        const detail = describeNoTextAnswer(data);\n        if (onNoText) onNoText(detail);\n        else callLog.warn(`answered with no text — ${detail}`);");
        expect((source.match(/\{ onNoText: \(detail\) => noTextDetails\.set\(c, detail\) \}/g) || []).length).toBe(2);
        expect(source).toContain('runLlmCall(call, userText, ac ? ac.signal : null, label, snapshotMsgId, macroContext, systemBlock, { onNoText })');
    });
});
