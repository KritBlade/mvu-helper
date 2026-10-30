/**
 * MVU Helper — SillyTavern macros in the prompt text mvu-helper writes (sillytavern/prompt-macros-core.js, and the
 * host half prompt-macros.js, which imports SillyTavern and is gated here as SOURCE).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { substituteMacrosBlock } from '../src/sillytavern/prompt-macros-core.js';

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('substituteMacrosBlock — a macro engine applied to one prompt block', () => {
    // Fake of SillyTavern.substituteParams: a tiny macro engine that records its input.
    const makeSub = (impl) => {
        const calls = [];
        const fn = (s) => { calls.push(s); return impl ? impl(s) : s.replace(/\{\{user\}\}/g, 'Goten'); };
        return { fn, calls };
    };

    it('no `{{` delimiter → returned unchanged, engine untouched, no onMissing', () => {
        const { fn, calls } = makeSub();
        let missed = false;
        const out = substituteMacrosBlock(fn, 'plain roster text, no macro', { onMissing: () => { missed = true; } });
        expect(out).toBe('plain roster text, no macro');
        expect(calls).toHaveLength(0);
        expect(missed).toBe(false);                              // macro-free blocks never warn
    });

    it('`{{` present but subFn missing → onMissing fires and the RAW block is returned', () => {
        let missedWith = null;
        const out = substituteMacrosBlock(null, 'Hi {{user}}', { onMissing: (raw) => { missedWith = raw; } });
        expect(out).toBe('Hi {{user}}');                        // graceful degrade to raw
        expect(missedWith).toBe('Hi {{user}}');
    });

    it('subFn present → macros are expanded and the result is returned', () => {
        const { fn, calls } = makeSub();
        const out = substituteMacrosBlock(fn, 'Hi {{user}}, welcome');
        expect(out).toBe('Hi Goten, welcome');
        expect(calls).toEqual(['Hi {{user}}, welcome']);
    });

    it('subFn throws → onError fires and the RAW block is returned', () => {
        const boom = () => { throw new Error('bad macro'); };
        let errWith = null;
        const out = substituteMacrosBlock(boom, '{{format_message_variable::stat_data}}', { onError: (e) => { errWith = e; } });
        expect(out).toBe('{{format_message_variable::stat_data}}'); // degrade to raw on error
        expect(errWith).toBeInstanceOf(Error);
    });

    it('subFn returning null/undefined → falls back to the raw block (never emits "null")', () => {
        expect(substituteMacrosBlock(() => null, 'keep {{user}}')).toBe('keep {{user}}');
    });

    it('tolerates null/empty text', () => {
        const { fn } = makeSub();
        expect(substituteMacrosBlock(fn, null)).toBe('');
        expect(substituteMacrosBlock(fn, '')).toBe('');
    });

    // ── full-decode mode (requireDelimiter:false) — the TavernHelper.formatAsTavernRegexedString path, where the
    //    regex step is NOT `{{`-gated, so the engine must run even on a block with no macros. ──
    it('requireDelimiter:false → engine runs even with no `{{` (regex step is not macro-gated)', () => {
        const { fn, calls } = makeSub((s) => `[regexed]${s}`);   // stand-in for regex+macros+macro-likes
        const out = substituteMacrosBlock(fn, 'plain block, no macro', { requireDelimiter: false });
        expect(out).toBe('[regexed]plain block, no macro');      // NOT short-circuited
        expect(calls).toEqual(['plain block, no macro']);
    });

    it('requireDelimiter:true (default) still short-circuits a macro-free block', () => {
        const { fn, calls } = makeSub();
        const out = substituteMacrosBlock(fn, 'plain block, no macro');
        expect(out).toBe('plain block, no macro');
        expect(calls).toHaveLength(0);                           // default fast path preserved
    });

    it('requireDelimiter:false with subFn missing → onMissing fires + RAW (no silent skip of a macro-free block)', () => {
        let missedWith = null;
        const out = substituteMacrosBlock(null, 'no macros here', { requireDelimiter: false, onMissing: (raw) => { missedWith = raw; } });
        expect(out).toBe('no macros here');
        expect(missedWith).toBe('no macros here');
    });
});

// SillyTavern expands macros in the prompt it assembles, never in a block added at CHAT_COMPLETION_PROMPT_READY, and a
// PRE/POST call's task token resolves after that call's decode. So every block mvu-helper adds goes through
// expandPromptMacros, and the reply's own text never does.
describe('SOURCE GATE — every block mvu-helper adds to a prompt has its SillyTavern macros expanded', () => {
    it('MUTATION TARGET — expandPromptMacros runs SillyTavern\'s substituteParams on the block', () => {
        const src = read('src/sillytavern/prompt-macros.js');
        expect(src).toContain("const substitute = ctx && typeof ctx.substituteParams === 'function' ? (block) => ctx.substituteParams(block) : null;");
        expect(src).toContain('return substituteMacrosBlock(substitute, text, {');
    });

    it('MUTATION TARGET — a routed task\'s instruction, on every route the router serves', () => {
        const router = read('src/features/llm-task-router/llm-task-router.js');
        const fn = router.slice(router.indexOf('async function resolveInstruction('), router.indexOf('// The instruction text of every ACTIVE task'));
        expect(fn).toContain("return expandPromptMacros(String((await Promise.resolve(v)) || '').trim(), 'llm-task-router');");
        expect(router).toContain('try { out[task.id] = await resolveInstruction(task, phase, messageId); }');
        expect(router).toContain('const body = taskEntryBody(task.tag, await resolveInstruction(task, NARRATE_TARGET));');
    });

    it('MUTATION TARGET — the narrator\'s picture parts and the picture call\'s count, never the reply', () => {
        const src = read('src/features/imagegen/image-gen.js');
        const parts = src.slice(src.indexOf('async function narratorPictureParts('), src.indexOf('async function maincharOutfitsOrNone('));
        expect(parts).toContain("rules: expandPromptMacros(narratorPictureRules({");
        expect(parts).toContain("breakTemplateOpeners(expandPromptMacros(scene, 'imagegen'))");
        expect(parts).toContain("count: expandPromptMacros(pictureCountRules(imageCap()), 'imagegen'),");
        expect(src).toContain("return readerPictureInput(numbered.text, imageCap(), (block) => expandPromptMacros(block, 'imagegen'));");
    });

    it('MUTATION TARGET — the roster\'s <reply_cast>', () => {
        const src = read('src/features/character-roster/reply-cast-prompt.js');
        expect(src).toContain("breakTemplateOpeners(expandPromptMacros(block, 'character-roster'))");
    });

    // A new place that adds a block to the narrator's prompt has to be listed here, and expand its block.
    it('every place that adds a block to the narrator\'s prompt is one this gate checks', () => {
        const walk = (dir) => readdirSync(dir).flatMap((name) => {
            const full = join(dir, name);
            return statSync(full).isDirectory() ? walk(full) : (full.endsWith('.js') ? [full] : []);
        });
        const srcDir = new URL('../src', import.meta.url);
        const sites = walk(srcDir.pathname.replace(/^\/([A-Za-z]:)/, '$1'))
            .flatMap((file) => readFileSync(file, 'utf8').split(/\r?\n/)
                .filter((line) => /\bchat\.(push|unshift|splice)\(/.test(line) && !line.trim().startsWith('//'))
                .map(() => file.replace(/\\/g, '/').replace(/^.*\/src\//, 'src/')));
        expect([...new Set(sites)].sort()).toEqual([
            'src/features/character-roster/reply-cast-prompt.js',
            'src/features/imagegen/prompt-assembly-core.js',
            'src/features/llm-task-router/llm-task-router.js',
        ]);
    });
});
