// tests/page-code-guard.test.js — text mvu-helper hands to the page on behalf of something the page must
// not run. An engine runs in the Worker and a menu in its frame so that their code never reaches the page;
// these guards keep what they PRODUCE, and what a model writes for mvu-helper to place, from getting there
// another way: reply text carrying a TavernHelper render token or ST-Prompt-Template's opener (an engine's
// swap or audit block, POST's block), a SillyTavern macro in stat_data or the model's words, a toast shown
// as HTML, and a bridge request from a window that is no menu frame.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    PAGE_CODE_TOKENS, PROMPT_TEMPLATE_OPENER, TAVERNHELPER_FRONTEND_TOKENS, pageCodeTokenIn, pageCodeTokenAdded, breakTemplateOpeners,
} from '../src/shared/rendered-region.js';
import { applyTextReplacements, auditBlockFromBody, TURN_AUDIT_TAG } from '../src/features/logic-engine/turn-runner-core.js';
import { postBlocksForReply } from '../src/features/small-llm/extra-llm-calls-core.js';
import { normalizeStatBoxSection, renderStatBox, expandIdentityMacros } from '../src/features/statbox/statbox-core.js';
import { menuBridgeSenderVerdict } from '../src/features/statusmenu-pack/statusmenu-frame-core.js';
import { composeImagePrompt, withoutMacroBraces } from '../src/features/imagegen/prompt-assembly-core.js';
import { toastOptions } from '../src/sillytavern/mvu-bridge-core.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const source = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

// Each token split in two, for the cases where an edit completes a token with the text beside it.
const halves = (token) => [token.slice(0, Math.ceil(token.length / 2)), token.slice(Math.ceil(token.length / 2))];

describe('the page-code tokens', () => {
    it('are TavernHelper\'s render tokens and ST-Prompt-Template\'s opener', () => {
        expect(PAGE_CODE_TOKENS).toEqual([...TAVERNHELPER_FRONTEND_TOKENS, PROMPT_TEMPLATE_OPENER]);
        expect(PROMPT_TEMPLATE_OPENER).toBe('<%');
    });

    it('pageCodeTokenIn names the token a text carries, and null for plain prose', () => {
        for (const token of PAGE_CODE_TOKENS) expect(pageCodeTokenIn('a ' + token + ' b')).toBe(token);
        expect(pageCodeTokenIn('Affection 13 (+3) · Mood calm → happy <b>bold</b>')).toBe(null);
        expect(pageCodeTokenIn(null)).toBe(null);
    });

    it('MUTATION TARGET — pageCodeTokenAdded counts, so a token completed across an edit is caught', () => {
        for (const token of PAGE_CODE_TOKENS) {
            const [head, tail] = halves(token);
            expect(pageCodeTokenAdded('x ' + head, 'x ' + head + tail), token).toBe(token);
            expect(pageCodeTokenAdded('x', 'x ' + token), token).toBe(token);
            expect(pageCodeTokenAdded('x ' + token, 'y ' + token), token).toBe(null);
            expect(pageCodeTokenAdded('x ' + token, 'x'), token).toBe(null);
        }
    });
});

describe('engine text written into a reply', () => {
    it('MUTATION TARGET — a swap that would add a page-code token is refused, and the text stays', () => {
        for (const token of PAGE_CODE_TOKENS) {
            const r = applyTextReplacements('before <slot/> after', { '<slot/>': 'x ' + token });
            expect(r.text, token).toBe('before <slot/> after');
            expect(r.refused, token).toEqual([{ find: '<slot/>', token }]);
        }
    });

    it('a swap that completes a token with the text beside it is refused too', () => {
        for (const token of PAGE_CODE_TOKENS) {
            const [head, tail] = halves(token);
            const r = applyTextReplacements('a ' + head + '<slot/>', { '<slot/>': tail });
            expect(r.text, token).toBe('a ' + head + '<slot/>');
            expect(r.refused.map((x) => x.token), token).toEqual([token]);
        }
    });

    it('the other swaps still apply, and a token the reply already carried is left alone', () => {
        const r = applyTextReplacements('prose <%= x %> <a/> <b/>', { '<a/>': 'ONE', '<b/>': '<% two %>' });
        expect(r.text).toBe('prose <%= x %> ONE <b/>');
        expect(r.refused).toEqual([{ find: '<b/>', token: '<%' }]);
        expect(r.counts).toEqual({ '<a/>': 1, '<b/>': 1 });
    });

    it('MUTATION TARGET — an audit body carrying a token writes no block, and says which token', () => {
        expect(auditBlockFromBody('Affection +3', TURN_AUDIT_TAG)).toEqual({
            block: `<${TURN_AUDIT_TAG}>\nAffection +3\n</${TURN_AUDIT_TAG}>`, refusedToken: null,
        });
        for (const token of PAGE_CODE_TOKENS) {
            expect(auditBlockFromBody('Affection +3 ' + token, TURN_AUDIT_TAG), token).toEqual({ block: '', refusedToken: token });
        }
    });

    it('the runner warns for each refusal and writes the block auditBlockFromBody returns', () => {
        const runner = source('src/features/logic-engine/turn-runner.js');
        expect(runner).toContain('for (const { find, token } of res.refused) log.warn(');
        expect(runner).toContain('const { block, refusedToken } = auditBlockFromBody(body, tag);');
        expect(runner).not.toMatch(/return wrapAuditBlock\(/);
    });
});

describe('POST\'s block written into a reply', () => {
    const UV = (body) => `<UpdateVariable>\n<JSONPatch>\n${body}\n</JSONPatch>\n</UpdateVariable>`;
    const OPS = '[ { "op": "replace", "path": "/World/Time/0", "value": "18:25" } ]';
    const noteCarrying = (token) => UV(`[ { "op": "replace", "path": "/World/Note", "value": "a ${token} b" } ]`);

    it('an ordinary block passes byte for byte', () => {
        const block = UV(OPS);
        expect(postBlocksForReply(`recorded:\n${block}\ndone`)).toEqual({ blocks: [block], refusedTokens: [] });
    });

    it('MUTATION TARGET — a block carrying a page-code token is refused, and says which token', () => {
        for (const token of PAGE_CODE_TOKENS) {
            expect(postBlocksForReply(noteCarrying(token)), token).toEqual({ blocks: [], refusedTokens: [token] });
        }
    });

    it('MUTATION TARGET — the clean blocks beside a refused one are kept', () => {
        const clean = UV(OPS);
        expect(postBlocksForReply(`${noteCarrying('<%')}\n${clean}`)).toEqual({ blocks: [clean], refusedTokens: ['<%'] });
    });

    it('an empty patch is still dropped, and no output reads as nothing', () => {
        expect(postBlocksForReply(UV('[]'))).toEqual({ blocks: [], refusedTokens: [] });
        expect(postBlocksForReply(null)).toEqual({ blocks: [], refusedTokens: [] });
    });

    it('MUTATION TARGET — the POST pass writes and applies only the kept blocks, and the relay hint reads the same', () => {
        const pass = source('src/features/small-llm/extra-llm-calls.js');
        expect(pass).toContain('const postParseComing = outputs.some((o) => postBlocksForReply(o.output).blocks.length > 0);');
        expect(pass).toContain('const { blocks: kept, refusedTokens } = postBlocksForReply(o.output);');
        expect(pass).toContain('blocks.push(...kept);');
        expect(pass).not.toContain('extractUpdateVariableBlocks(o.output)');
    });

    it('MUTATION TARGET — each refused block is warned with its token, and the decision line counts them', () => {
        const pass = source('src/features/small-llm/extra-llm-calls.js');
        expect(pass).toContain('for (const refusedToken of refusedTokens) {\n                log.child(o.label).warn(`this call\'s <UpdateVariable> block carries "${refusedToken}" — NOT written into the reply and NOT applied.');
        expect(pass).toContain('refusedBlockCount += refusedTokens.length;');
        expect(pass).toContain('POST ${blocks.length} block(s)${refusedBlockCount ? ` (${refusedBlockCount} refused: page code)` : \'\'}');
    });
});

describe('the stat box', () => {
    const section = normalizeStatBoxSection({
        open: '<box>', close: '</box>', placeBefore: ['</story>'],
        groups: [{ path: 'Party', kind: 'collection', nameField: 'Name', fields: [{ path: 'Mood', label: 'Mood' }] }],
    }, { retired: [], unknown: [], blocked: [] });

    it('MUTATION TARGET — a line whose stat_data carries a page-code token is left out and reported', () => {
        for (const token of PAGE_CODE_TOKENS) {
            const refused = [];
            const box = renderStatBox(section,
                { Party: { a: { Name: 'Ann', Mood: 'calm' }, b: { Name: 'Bea', Mood: 'calm' }, c: { Name: 'Cy', Mood: 'calm' } } },
                { Party: { a: { Name: 'Ann', Mood: 'happy' }, b: { Name: 'Bea', Mood: 'x ' + token }, c: { Name: 'Cy ' + token, Mood: 'sad' } } },
                { onRefused: (r) => refused.push(r) });
            expect(box, token).toBe('<box>\nAnn: Mood calm → happy\n</box>');
            expect(refused, token).toEqual([{ key: 'b', token }, { key: 'c', token }]);
        }
    });

    it('MUTATION TARGET — member names expand {{user}} and {{char}} only; every other macro stays as written', () => {
        const names = { user: 'Critblade', char: 'Narrator' };
        expect(expandIdentityMacros('{{user}} and {{Char}} and {{USER}}', names)).toBe('Critblade and Narrator and Critblade');
        expect(expandIdentityMacros('{{setvar::a::b}}{{getglobalvar::key}}{{random::1,2}}', names))
            .toBe('{{setvar::a::b}}{{getglobalvar::key}}{{random::1,2}}');
        expect(expandIdentityMacros('{{user}}', { user: '$& $1', char: '' })).toBe('$& $1');
    });

    it('the host expands names with expandIdentityMacros, never SillyTavern\'s macro engine', () => {
        const host = source('src/features/statbox/statbox.js');
        expect(host).toContain('expandIdentityMacros(name, names)');
        expect(host).not.toMatch(/substituteParams/);
    });
});

describe('prompt blocks mvu-helper builds out of stat_data', () => {
    it('MUTATION TARGET — breakTemplateOpeners breaks every opener and counts them', () => {
        expect(breakTemplateOpeners('a <% b %> c <%= d %>')).toEqual({ text: 'a < % b %> c < %= d %>', broken: 2 });
        expect(breakTemplateOpeners('Classmate · Mitsuki')).toEqual({ text: 'Classmate · Mitsuki', broken: 0 });
        expect(pageCodeTokenIn(breakTemplateOpeners('<%- x %>').text)).toBe(null);
    });

    it('the cast block and the scene roster are pushed broken', () => {
        expect(source('src/features/character-roster/reply-cast-prompt.js'))
            .toContain("const guarded = breakTemplateOpeners(expandPromptMacros(block, 'character-roster'));");
        expect(source('src/features/character-roster/reply-cast-prompt.js')).toContain("eventData.chat.push({ role: 'system', content: guarded.text });");
        const imagegen = source('src/features/imagegen/image-gen.js');
        expect(imagegen).toContain("const guardedScene = breakTemplateOpeners(expandPromptMacros(scene, 'imagegen'));");
        expect(imagegen).toContain('scene: guardedScene.text,');
    });
});

describe('the StatusMenu bridge answers a contained menu frame only', () => {
    const bridgeTypes = new Set(['menu-a', 'menu-b']);

    it('MUTATION TARGET — a bridge request from a window that is no menu frame is refused', () => {
        const v = menuBridgeSenderVerdict({ type: 'menu-a' }, { bridgeTypes, isMenuFrame: () => false });
        expect(v.isBridge).toBe(true);
        expect(v.ok).toBe(false);
        expect(v.isSenderGone).toBe(false);
        expect(v.reason).toMatch(/not a contained menu frame/);
        expect(menuBridgeSenderVerdict({ type: 'menu-b' }, { bridgeTypes, isMenuFrame: () => true }))
            .toEqual({ isBridge: true, ok: true, isSenderGone: false, reason: '' });
    });

    it('MUTATION TARGET — a request whose sender no longer exists goes unanswered, named as the race it is', () => {
        let asked = 0;
        const v = menuBridgeSenderVerdict({ type: 'menu-a' }, { bridgeTypes, hasSender: false, isMenuFrame: () => { asked += 1; return true; } });
        expect(v.isBridge).toBe(true);
        expect(v.ok).toBe(false);
        expect(v.isSenderGone).toBe(true);
        expect(v.reason).toMatch(/no longer exists/);
        expect(asked).toBe(0);
    });

    it('MUTATION TARGET — the dispatcher says whether a request has a sender, and logs a gone one at verbose, a stranger as a warning', () => {
        const dispatcher = source('src/features/statusmenu-pack/statusmenu-dispatcher.js');
        expect(dispatcher).toContain('hasSender: Boolean(event && event.source),');
        expect(dispatcher).toContain("if (sender.isSenderGone) log.verbose('a bridge request went unanswered: ' + sender.reason);");
        expect(dispatcher).toContain("else log.warn('a bridge request was refused: ' + sender.reason);");
    });

    it('anything else on the window is not a bridge request, and costs no frame scan', () => {
        let asked = 0;
        const isMenuFrame = () => { asked += 1; return false; };
        for (const data of [{ type: 'other' }, { type: 7 }, 'menu-a', null, undefined]) {
            expect(menuBridgeSenderVerdict(data, { bridgeTypes, isMenuFrame }).isBridge).toBe(false);
        }
        expect(asked).toBe(0);
    });

    it('MUTATION TARGET — the dispatcher checks the sender before any lane reads, for all six requests', () => {
        const dispatcher = source('src/features/statusmenu-pack/statusmenu-dispatcher.js');
        const listener = dispatcher.slice(dispatcher.indexOf('export function wireStatusMenuDispatcher'));
        const check = listener.indexOf('if (sender.isBridge && !sender.ok) {');
        expect(check).toBeGreaterThan(-1);
        expect(listener.slice(check, listener.indexOf('}', check))).toContain('return;');
        for (const reader of ['readMenuLorebookContentRequest(', 'readMenuImageRequest(', 'readMenuLinkRequest(',
            'readMenuFormatterRequest(', 'readMenuActionInputsRequest(', 'readMenuActionRequest(']) {
            expect(listener.indexOf(reader), reader).toBeGreaterThan(check);
        }
        const listStart = dispatcher.indexOf('const MENU_BRIDGE_REQUEST_TYPES');
        expect(listStart).toBeGreaterThan(-1);
        const list = dispatcher.slice(listStart, dispatcher.indexOf(']);', listStart));
        for (const type of ['MENU_LOREBOOK_CONTENT_MESSAGE', 'MENU_IMAGE_MESSAGE', 'MENU_LINK_MESSAGE',
            'MENU_FORMATTER_MESSAGE', 'MENU_ACTION_INPUTS_MESSAGE', 'MENU_ACTION_MESSAGE']) {
            expect(list, type).toContain(type);
        }
    });
});

describe('the model\'s words on their way to /sd', () => {
    it('withoutMacroBraces takes out every {{ and }}', () => {
        expect(withoutMacroBraces('a {{setvar::k::v}} b }} {{')).toBe('a setvar::k::v b  ');
        expect(withoutMacroBraces(null)).toBe('');
    });

    it('MUTATION TARGET — the composed prompt keeps the prefix\'s macros and no other', () => {
        const prompt = composeImagePrompt({
            prefix: 'masterpiece, {{char}} style',
            composition: 'standing {{setvar::k::v}} in rain',
            people: [{ name: 'Ann{{x}}', body: 'red {{y}} hair', clothes: 'coat' }],
            mainchar: { body: 'tall {{z}}', clothes: 'suit' },
        });
        expect(prompt.startsWith('masterpiece, {{char}} style, ')).toBe(true);
        expect(prompt.slice('masterpiece, {{char}} style, '.length)).not.toMatch(/\{\{|\}\}/);
        expect(prompt).toContain('standing setvar::k::v in rain');
    });

    it('a regenerated picture with no <pic> sends its title the same way', () => {
        expect(source('src/features/imagegen/image-gen.js')).toContain("prompt = withoutMacroBraces($img.attr('title') || '').trim();");
    });
});

describe('every toast is shown as text', () => {
    it('MUTATION TARGET — toastOptions sets escapeHtml past whatever the caller passed', () => {
        expect(toastOptions({ timeOut: 9000, escapeHtml: false })).toEqual({ timeOut: 9000, escapeHtml: true });
        expect(toastOptions(undefined)).toEqual({ escapeHtml: true });
    });

    it('the wrapper uses it, and no other file calls toastr directly', () => {
        expect(source('src/sillytavern/mvu-bridge.js')).toContain('toastr[kind](msg, title, toastOptions(options))');
        const direct = /\btoastr\s*(?:\.\s*(?:success|info|warning|error)\s*\(|\[)/;
        const offenders = [];
        const walk = (dir) => {
            for (const name of readdirSync(join(ROOT, dir))) {
                const rel = dir + '/' + name;
                if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue; }
                if (!rel.endsWith('.js') || rel === 'src/sillytavern/mvu-bridge.js') continue;
                if (direct.test(source(rel))) offenders.push(rel);
            }
        };
        walk('src');
        expect(offenders).toEqual([]);
    });
});

describe('the MVU bootstrap', () => {
    it('MUTATION TARGET — loads MVU from one pinned release tag', () => {
        expect(source('src/features/mvu-bootstrap/mvu-bootstrap.js'))
            .toMatch(/const MVU_BUNDLE_URL = 'https:\/\/testingcf\.jsdelivr\.net\/gh\/MagicalAstrogy\/MagVarUpdate@v\d+\.\d+\.\d+\/artifact\/bundle\.js';/);
    });
});
