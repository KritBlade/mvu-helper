// tests/template-reach.test.js — what a pack's template code can reach (src/shared/template-reach.js;
// plans/pack-install-warning.md §3, W1 and W2).
//
// What each block guards, and the mutation that proves the guard is one (run by hand, recorded):
//   • the code is read the way EJS compiles it — MUTATION: read `<%#` as code → the comment-tag test fails;
//     read `<%%` as code → the literal test fails; drop the text between tags → the template-literal test fails;
//     drop the decoded second reading of a regex replacement → the entity test fails;
//   • strings and comments never count, an escaped name does — MUTATION: let a string end at its first quote
//     without reading it → the string test fails; stop skipping comments → the comment test fails; stop decoding
//     `\u` in names → the escaped-name test fails; read `/` after `if (…)` as a division → the regex test fails;
//   • each rule fires on its own case and only there — MUTATION: drop any one rule (a settings name, a class,
//     the type rule's allowed set, its spread / `__proto__` / held checks, ST-Prompt-Template's global scope,
//     its global helpers, execute, the page reach, a root's member, the unchecked roots, `.constructor`, the
//     string timer, a SillyTavern class, an object ruled by its member, the getContext() alias) → that rule's
//     test fails; drop the object-key or the typeof exemption → the allowed cases report;
//   • every TavernHelper member sits in one class, and each class reports as Appendix A says (W2); every
//     SillyTavern member likewise, as Appendix B says;
//   • SillyTavern's global-variable macros are found in every text it runs macros over — MUTATION: drop a name
//     of the family, the case-insensitive match, the flags before a name, the `$` shorthand, or the texts that
//     carry macros only → that test fails;
//   • the tokenizer agrees with acorn's over every case here and over School's workspace, and School's
//     workspace — both artifacts ArtificKoi installs — reaches nothing.
//
// What no test here can see: what ST-Prompt-Template really runs in a rendered message after markdown and
// sanitising. The decoded second reading covers the character references a browser turns back into code.

import { describe, it, expect } from 'vitest';
import * as acorn from 'acorn';
import {
    templateReachIn, ejsSourceOf, templateCodeTokens, addTemplateReach, TAVERN_HELPER_MEMBER_CLASSES, SILLYTAVERN_MEMBER_CLASSES,
} from '../src/shared/template-reach.js';
import { packReachTexts } from '../src/features/gamelogic-pack/gamelogic-pack-core.js';
import { menuReachTexts } from '../src/features/statusmenu-pack/statusmenu-pack-core.js';
import { haveSchoolv4, schoolv4Artifact } from './schoolv4-artifact.mjs';

const NOTHING = { settings: [], beyondChat: [], unchecked: [] };
const inEntry = (text) => templateReachIn({ entries: [text] });
const inReplacement = (text) => templateReachIn({ regexReplacements: [text] });

describe('what it reads — the code EJS compiles', () => {
    it('reads every code tag: statement, both outputs, the slurping forms', () => {
        expect(inEntry('<% fetch(1) %>').beyondChat).toEqual(['fetch']);
        expect(inEntry('<%= document.title %>').beyondChat).toEqual(['document']);
        expect(inEntry('<%- eval("1") %>').beyondChat).toEqual(['eval']);
        expect(inEntry('a <%_ execute("/x") _%> b <% fetch(2) -%>').beyondChat).toEqual(['execute', 'fetch']);
    });
    it('MUTATION TARGET — a comment tag is no code', () => {
        expect(inEntry('<%# fetch(1) %>')).toEqual(NOTHING);
    });
    it('MUTATION TARGET — `<%%` is literal text, up to its closing tag', () => {
        expect(inEntry('<%% fetch(1) %>')).toEqual(NOTHING);
    });
    it('text outside a tag is no code', () => {
        expect(inEntry('fetch(1) and document, outside any tag <% const a = 1; %>')).toEqual(NOTHING);
    });
    // EJS appends the text in a double-quoted string, so a `"` there would break the compiled template: the case
    // that runs uses single quotes.
    it('MUTATION TARGET — a template literal carried across tags makes the text between them code', () => {
        expect(inEntry('<% var x = `%>${fetch(\'/x\')}<% ` %>').beyondChat).toEqual(['fetch']);
    });
    it('MUTATION TARGET — a regex replacement is read again with its character references decoded', () => {
        expect(inReplacement('&lt;% fetch(1) %&gt;').beyondChat).toEqual(['fetch']);
        expect(inReplacement('&#60;&#x25; document %&gt;').beyondChat).toEqual(['document']);
        expect(inReplacement('&lt% &#102;etch(1) %&gt;').beyondChat).toEqual(['fetch']);
    });
    it('an entry is never read that way: it reaches the prompt as text', () => {
        expect(inEntry('&lt;% fetch(1) %&gt;')).toEqual(NOTHING);
    });
    it('the raw reading stays, so decoding cannot hide code inside a string', () => {
        expect(inReplacement('<% s = "&#34;"; fetch(1) %>').beyondChat).toEqual(['fetch']);
    });
    it('ejsSourceOf appends text as EJS does and keeps a trailing line comment off the appended code', () => {
        expect(ejsSourceOf('a"b<%= x // note %>')).toBe('    ; __append("a\\"b")\n    ; __append(escapeFn( x // note \n))\n');
    });
});

describe('what it reads — tokens, never strings or comments', () => {
    it('MUTATION TARGET — a name inside a string is not read', () => {
        expect(inEntry('<% const s = "TavernHelper.deleteWorldbook(x); fetch(1)"; %>')).toEqual(NOTHING);
        expect(inEntry('<% const s = \'document\\\' + eval\'; %>')).toEqual(NOTHING);
    });
    it('MUTATION TARGET — a name inside a comment is not read', () => {
        expect(inEntry('<% // fetch(1)\n/* document */ const a = 1; %>')).toEqual(NOTHING);
    });
    it('MUTATION TARGET — an escaped name is read as the name it spells', () => {
        expect(inEntry('<% \\u0066etch(1) %>').beyondChat).toEqual(['fetch']);
        expect(inEntry('<% \\u{64}ocument.title %>').beyondChat).toEqual(['document']);
    });
    it('MUTATION TARGET — after an if condition, `/` opens a regex: a quote inside it hides nothing', () => {
        expect(inEntry('<% if (a) /\'/.test(b); fetch(1) %>').beyondChat).toEqual(['fetch']);
    });
    it('a division is no regex: what follows it is still read', () => {
        expect(inEntry('<% const r = a / b; const s = c / 2; fetch(1) %>').beyondChat).toEqual(['fetch']);
    });
    it('a `${…}` inside a template literal is code', () => {
        expect(inEntry('<% const t = `a ${ `b ${ document.title }` } c`; %>').beyondChat).toEqual(['document']);
    });
    it('a string option is read by its value: escapes cannot spell another', () => {
        expect(inEntry('<% setvar("x", 1, "\\x67lobal") %>').settings).toEqual(['setvar(\'global\')']);
        expect(inEntry('<% setvar("x", 1, "\\147lobal") %>').settings).toEqual(['setvar(\'global\')']);
    });
});

describe('settings', () => {
    it('MUTATION TARGET — a name holding SillyTavern\'s settings, as a global or as a member', () => {
        expect(inEntry('<% const s = SillyTavern.extensionSettings; %>').settings).toEqual(['extensionSettings']);
        expect(inEntry('<% extension_settings.x = 1 %>').settings).toEqual(['extension_settings']);
        expect(inEntry('<% SillyTavern.chatCompletionSettings; SillyTavern.textCompletionSettings; SillyTavern.powerUserSettings; SillyTavern.accountStorage %>').settings)
            .toEqual(['chatCompletionSettings', 'textCompletionSettings', 'powerUserSettings', 'accountStorage']);
    });
    it('MUTATION TARGET — a TavernHelper call kept in SillyTavern\'s settings (C1)', () => {
        expect(inEntry('<% TavernHelper.setLorebookSettings({}) %>').settings).toEqual(['TavernHelper.setLorebookSettings']);
    });
    it('MUTATION TARGET — ST-Prompt-Template\'s global helpers, and activateRegex', () => {
        expect(inEntry('<% setGlobalVar("x", 1); getGlobalVar("y") %>').settings).toEqual(['setGlobalVar', 'getGlobalVar']);
        expect(inEntry('<% activateRegex(/a/, "b") %>').settings).toEqual(['activateRegex']);
    });
    it('MUTATION TARGET — a SillyTavern member kept in SillyTavern\'s settings (C1)', () => {
        expect(inEntry('<% SillyTavern.saveSettingsDebounced(); SillyTavern.getContext().importTags(c); SillyTavern.tagMap[a] = [] %>').settings)
            .toEqual(['SillyTavern.saveSettingsDebounced', 'SillyTavern.importTags', 'SillyTavern.tagMap']);
    });
    it('MUTATION TARGET — SillyTavern\'s global variables, and a preset written through getPresetManager()', () => {
        expect(inEntry('<% SillyTavern.variables.global.set("k", 1); SillyTavern.getContext().variables?.global?.get("k") %>').settings)
            .toEqual(['SillyTavern.variables.global']);
        expect(inEntry('<% SillyTavern.getPresetManager("openai").savePreset("x", p); SillyTavern.getContext().getPresetManager().deletePreset("y") %>').settings)
            .toEqual(['SillyTavern.getPresetManager().savePreset', 'SillyTavern.getPresetManager().deletePreset']);
        expect(inEntry('<% SillyTavern.getPresetManager(pick(a, [b])).renamePreset(x, y) %>').settings).toEqual(['SillyTavern.getPresetManager().renamePreset']);
    });
});

describe('SillyTavern\'s macros — its global variables, kept in its settings', () => {
    const FAMILY = [
        'setglobalvar', 'addglobalvar', 'incglobalvar', 'decglobalvar', 'deleteglobalvar', 'flushglobalvar', 'setglobalvarkey',
        'setglobalvarindex', 'getglobalvar', 'hasglobalvar', 'globalvarexists', 'getglobalvarkey', 'getglobalvarindex',
    ];
    it('MUTATION TARGET — a macro writing or reading them, in an entry or a regex replacement, with no template code', () => {
        expect(inEntry('Mood: {{setglobalvar::mood::calm}} now {{getglobalvar::mood}}').settings)
            .toEqual(['{{setglobalvar::…}}', '{{getglobalvar::…}}']);
        expect(inReplacement('<b>{{incglobalvar::visits}}</b>').settings).toEqual(['{{incglobalvar::…}}']);
    });
    it('MUTATION TARGET — every name of the family, aliases included', () => {
        for (const name of FAMILY) expect(inEntry('{{' + name + '::x::1}}'), name).toEqual({ ...NOTHING, settings: ['{{' + name + '::…}}'] });
    });
    it('MUTATION TARGET — in any case, after flags or spaces, with spaces before its arguments', () => {
        expect(inEntry('{{SetGlobalVar::k::1}}').settings).toEqual(['{{setglobalvar::…}}']);
        expect(inEntry('{{ !getglobalvar::k}}').settings).toEqual(['{{getglobalvar::…}}']);
        expect(inEntry('{{#hasglobalvar k}}').settings).toEqual(['{{hasglobalvar::…}}']);
        expect(inEntry('{{ deleteglobalvar :: k }}').settings).toEqual(['{{deleteglobalvar::…}}']);
    });
    it('MUTATION TARGET — the $ shorthand of the newer engine, a read or a write', () => {
        for (const text of ['{{$score = 5}}', '{{ $score++ }}', '{{$score}}', '{{~$score += 2}}']) {
            expect(inEntry(text), text).toEqual({ ...NOTHING, settings: ['{{$…}}'] });
        }
    });
    it('MUTATION TARGET — the texts that carry macros only are searched for macros, and never read as code', () => {
        expect(templateReachIn({ macroTexts: ['hello', '{{setglobalvar::seen::1}}'] }).settings).toEqual(['{{setglobalvar::…}}']);
        expect(templateReachIn({ macroTexts: ['<% fetch(1) %>'] })).toEqual(NOTHING);
    });
    it('found inside template code too: the scan cannot tell when a printed macro runs', () => {
        expect(inEntry('<%= "{{setglobalvar::k::1}}" %>').settings).toEqual(['{{setglobalvar::…}}']);
    });
    it('the chat\'s own variables, other macros and look-alike names pass', () => {
        expect(inEntry('{{setvar::k::1}} {{getvar::k}} {{.k = 1}} {{.k}} {{user}} {{random::a,b}} {{$5}} setglobalvar::x {{setglobalvariable}} {{getglobalvars}}'))
            .toEqual(NOTHING);
    });
});

describe('the type rule — TavernHelper\'s variable functions', () => {
    it('no option, or this message\'s, this chat\'s or this character\'s store, passes', () => {
        expect(inEntry('<% TavernHelper.getVariables(); TavernHelper.getVariables({ type: "message", message_id: 3 }); TavernHelper.getVariables({ type: \'chat\' }); TavernHelper.getVariables({ type: "character" }) %>')).toEqual(NOTHING);
        expect(inEntry('<% TavernHelper.replaceVariables(v, { type: "chat" }); TavernHelper.insertVariables({ a: 1 }) %>')).toEqual(NOTHING);
    });
    it('an option with no type reaches no store and passes', () => {
        expect(inEntry('<% TavernHelper.getVariables({ message_id: 3 }) %>')).toEqual(NOTHING);
    });
    it('MUTATION TARGET — any other store warns, for a read and for a write', () => {
        expect(inEntry('<% TavernHelper.getVariables({ type: "extension", extension_id: "x" }) %>').settings).toEqual(['TavernHelper.getVariables({ type: \'extension\' })']);
        expect(inEntry('<% TavernHelper.replaceVariables({}, { type: "extension" }) %>').settings).toEqual(['TavernHelper.replaceVariables({ type: \'extension\' })']);
        expect(inEntry('<% TavernHelper.getVariables({ type: "global" }) %>').settings).toEqual(['TavernHelper.getVariables({ type: \'global\' })']);
    });
    it('MUTATION TARGET — an option that is not a literal, or a type that is not one, cannot be checked', () => {
        expect(inEntry('<% TavernHelper.getVariables(option) %>').settings).toEqual(['TavernHelper.getVariables(an option that cannot be checked)']);
        expect(inEntry('<% TavernHelper.getVariables({ type: t }) %>').settings).toEqual(['TavernHelper.getVariables(an option that cannot be checked)']);
        expect(inEntry('<% TavernHelper.getVariables({ type }) %>').settings).toEqual(['TavernHelper.getVariables(an option that cannot be checked)']);
        expect(inEntry('<% TavernHelper.getVariables("chat") %>').settings).toEqual(['TavernHelper.getVariables(an option that cannot be checked)']);
    });
    it('MUTATION TARGET — a spread, a computed key or a __proto__ can carry another type', () => {
        const unchecked = ['TavernHelper.getVariables(an option that cannot be checked)'];
        expect(inEntry('<% TavernHelper.getVariables({ ...option, type: "chat" }) %>').settings).toEqual(unchecked);
        expect(inEntry('<% TavernHelper.getVariables({ [key]: "chat" }) %>').settings).toEqual(unchecked);
        expect(inEntry('<% TavernHelper.getVariables({ __proto__: { type: "global" } }) %>').settings).toEqual(unchecked);
        expect(inEntry('<% TavernHelper.getVariables({ get type() { return "global"; } }) %>').settings).toEqual(unchecked);
    });
    it('MUTATION TARGET — a variable function held without a call cannot be checked', () => {
        expect(inEntry('<% const read = TavernHelper.getVariables; %>').settings).toEqual(['TavernHelper.getVariables, held without a call']);
        expect(inEntry('<% TavernHelper.getVariables.call(null, o) %>').settings).toEqual(['TavernHelper.getVariables, held without a call']);
    });
    it('the option of every write is its second argument, of a read its first', () => {
        expect(inEntry('<% TavernHelper.deleteVariable("x", { type: "global" }) %>').settings).toEqual(['TavernHelper.deleteVariable({ type: \'global\' })']);
        expect(inEntry('<% TavernHelper.registerVariableSchema(s, { type: "preset" }) %>').settings).toEqual(['TavernHelper.registerVariableSchema({ type: \'preset\' })']);
        expect(inEntry('<% TavernHelper.updateVariablesWith((v) => v, { type: "chat" }) %>')).toEqual(NOTHING);
    });
});

describe('the scope rule — ST-Prompt-Template\'s variable functions', () => {
    it('no option, another shorthand, a boolean, or a scope of this chat passes', () => {
        expect(inEntry('<% getvar("a"); setvar("b", 1); setvar("c", 2, "message"); getvar("d", true); incvar("e", 1, { scope: "local", outscope: "message" }); insvar("f", 1, 0, "nx") %>')).toEqual(NOTHING);
    });
    it('MUTATION TARGET — the global scope warns, as a shorthand or in any of the three keys', () => {
        expect(inEntry('<% setvar("x", 1, "global") %>').settings).toEqual(['setvar(\'global\')']);
        expect(inEntry('<% getvar("x", { scope: "global" }) %>').settings).toEqual(['getvar({ scope: \'global\' })']);
        expect(inEntry('<% incvar("x", 1, { inscope: "global" }) %>').settings).toEqual(['incvar({ inscope: \'global\' })']);
        expect(inEntry('<% decvar("x", 1, { outscope: "global" }) %>').settings).toEqual(['decvar({ outscope: \'global\' })']);
    });
    it('the option sits where each function takes it', () => {
        expect(inEntry('<% delvar("x", 0, "global"); insvar("y", 1, 0, "global"); patchVariables("z", p, "global") %>').settings)
            .toEqual(['delvar(\'global\')', 'insvar(\'global\')', 'patchVariables(\'global\')']);
        expect(inEntry('<% delvar("x", "global") %>')).toEqual(NOTHING);   // the second argument is delvar's index
    });
    it('an option that is not a literal, or a function held without a call, cannot be checked', () => {
        expect(inEntry('<% setvar("x", 1, option) %>').settings).toEqual(['setvar(an option that cannot be checked)']);
        expect(inEntry('<% const set = setvar; %>').settings).toEqual(['setvar, held without a call']);
    });
    it('a getvar checked with typeof and then called is School\'s pattern, and passes', () => {
        expect(inEntry('<% const g = (typeof getvar === "function" ? getvar("stat_data") : null); %>')).toEqual(NOTHING);
    });
});

describe('beyond this chat', () => {
    it('MUTATION TARGET — ST-Prompt-Template\'s execute, evalTemplate and define', () => {
        expect(inEntry('<% await execute("/echo hi") %>').beyondChat).toEqual(['execute']);
        expect(inEntry('<% const run = execute; %>').beyondChat).toEqual(['execute']);
        expect(inEntry('<% await evalTemplate(text); define("getvar", f) %>').beyondChat).toEqual(['evalTemplate', 'define']);
    });
    it('MUTATION TARGET — a TavernHelper call outside this chat (C3, D) and a member TavernHelper does not list', () => {
        expect(inEntry('<% TavernHelper.deleteWorldbook("x"); TavernHelper.triggerSlash("/x"); TavernHelper.somethingNew() %>').beyondChat)
            .toEqual(['TavernHelper.deleteWorldbook', 'TavernHelper.triggerSlash', 'TavernHelper.somethingNew']);
    });
    it('MUTATION TARGET — a SillyTavern member outside this chat (C3, D), and a member SillyTavern does not list', () => {
        expect(inEntry('<% SillyTavern.executeSlashCommandsWithOptions("/x"); SillyTavern.renameChat(a, b); SillyTavern.somethingNew(); SillyTavern.chat.length %>').beyondChat)
            .toEqual(['SillyTavern.executeSlashCommandsWithOptions', 'SillyTavern.renameChat', 'SillyTavern.somethingNew']);
        expect(inEntry('<% globalThis.SillyTavern.getContext().generateRaw({}) %>').beyondChat).toEqual(['SillyTavern.generateRaw']);
    });
    it('MUTATION TARGET — a model call, a hook on every event, macro or command, the browser\'s storage', () => {
        expect(inEntry('<% SillyTavern.sendGenerationRequest("quiet", d); SillyTavern.ChatCompletionService.processRequest(r); SillyTavern.macros.register("m", o); SillyTavern.eventSource.on(e, f); SillyTavern.SlashCommandParser.addCommandObject(c) %>').beyondChat)
            .toEqual(['SillyTavern.sendGenerationRequest', 'SillyTavern.ChatCompletionService', 'SillyTavern.macros', 'SillyTavern.eventSource', 'SillyTavern.SlashCommandParser']);
        expect(inEntry('<% window.SillyTavern.libs.localforage.setItem("k", 1); SillyTavern.getPresetManager().somethingNew() %>').beyondChat)
            .toEqual(['SillyTavern.libs.localforage', 'SillyTavern.getPresetManager().somethingNew']);
    });
    it('MUTATION TARGET — the page\'s own reach, and SillyTavern\'s request headers', () => {
        const page = 'fetch(1); new XMLHttpRequest(); new WebSocket(u); new EventSource(u); navigator.sendBeacon(u); import(u); eval(s); Function(s); document.title; localStorage.x; sessionStorage.x; indexedDB.open(n); jQuery.ajax(o); $.post(u)';
        expect(inEntry('<% ' + page + ' %>').beyondChat).toEqual([
            'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'navigator', 'import()', 'eval', 'Function', 'document', 'localStorage',
            'sessionStorage', 'indexedDB', 'jQuery', '$',
        ]);
        expect(inEntry('<% SillyTavern.getRequestHeaders(); new SillyTavern.ConnectionManagerRequestService() %>').beyondChat)
            .toEqual(['getRequestHeaders', 'ConnectionManagerRequestService']);
    });
    it('MUTATION TARGET — a member of a root is ruled as that global', () => {
        expect(inEntry('<% window.fetch(1); globalThis.window.document.title; self.eval(s); this.execute("/x"); locals.define("a", 1) %>').beyondChat)
            .toEqual(['fetch', 'document', 'eval', 'execute', 'define']);
    });
    it('a member of anything else is not', () => {
        expect(inEntry('<% response.fetch(1); page.document; tools.execute(1) %>')).toEqual(NOTHING);
    });
    it('MUTATION TARGET — `.constructor` reaches Function', () => {
        expect(inEntry('<% [].constructor.constructor("return 1")() %>').beyondChat).toEqual(['constructor']);
        expect(inEntry('<% 1..constructor.constructor("x")() %>').beyondChat).toEqual(['constructor']);
    });
    it('MUTATION TARGET — a timer given a string evaluates it; given a function it does not', () => {
        expect(inEntry('<% setTimeout("fetch(1)", 1) %>').beyondChat).toEqual(['setTimeout(string)']);
        expect(inEntry('<% setInterval(`x`, 1) %>').beyondChat).toEqual(['setInterval(string)']);
        expect(inEntry('<% setTimeout(() => {}, 1) %>')).toEqual(NOTHING);
    });
});

describe('unchecked use', () => {
    it('MUTATION TARGET — TavernHelper aliased, indexed or passed along', () => {
        expect(inEntry('<% const T = TavernHelper; %>').unchecked).toEqual(['TavernHelper']);
        expect(inEntry('<% TavernHelper["delete" + "Worldbook"]("x") %>').unchecked).toEqual(['TavernHelper[…]']);
        expect(inEntry('<% use(TavernHelper) %>').unchecked).toEqual(['TavernHelper']);
    });
    it('SillyTavern aliased, and a getContext() result held', () => {
        expect(inEntry('<% const st = SillyTavern; %>').unchecked).toEqual(['SillyTavern']);
        expect(inEntry('<% const context = globalThis.SillyTavern.getContext(); %>').unchecked).toEqual(['SillyTavern.getContext()']);
    });
    it('MUTATION TARGET — an object ruled by its member, held or indexed', () => {
        expect(inEntry('<% const v = SillyTavern.variables; SillyTavern.variables["glo" + "bal"].set(k, 1) %>').unchecked)
            .toEqual(['SillyTavern.variables', 'SillyTavern.variables[…]']);
        expect(inEntry('<% const manager = SillyTavern.getPresetManager(); %>').unchecked).toEqual(['SillyTavern.getPresetManager()']);
        expect(inEntry('<% const make = SillyTavern.getContext().getPresetManager; %>').unchecked).toEqual(['SillyTavern.getPresetManager()']);
        expect(inEntry('<% const { lodash } = SillyTavern.libs; %>').unchecked).toEqual(['SillyTavern.libs']);
    });
    it('MUTATION TARGET — window, globalThis and locals used other than through a member', () => {
        expect(inEntry('<% globalThis["fe" + "tch"](1) %>').unchecked).toEqual(['globalThis[…]']);
        expect(inEntry('<% const w = window; const l = locals; %>').unchecked).toEqual(['window', 'locals']);
    });
    it('MUTATION TARGET — self indexed reads the page as window does', () => {
        expect(inEntry('<% self["fe" + "tch"](1) %>').unchecked).toEqual(['self[…]']);
    });
    it('self, top, parent, frames and this are everyday names: used bare, only their members are read', () => {
        expect(inEntry('<% const self = this; let top = 0; const parent = node.parent; frames.push(1); this.x = 1; parent[0]; this[key] %>')).toEqual(NOTHING);
    });
});

describe('allowed', () => {
    it('MUTATION TARGET — typeof reads nothing: a check passes, a typeof of a call does not', () => {
        expect(inEntry('<% if (typeof TavernHelper !== "undefined" && typeof TavernHelper.getVariables === "function") {} %>')).toEqual(NOTHING);
        expect(inEntry('<% typeof fetch; typeof window.document %>')).toEqual(NOTHING);
        expect(inEntry('<% typeof TavernHelper.deleteWorldbook("x") %>').beyondChat).toEqual(['TavernHelper.deleteWorldbook']);
    });
    it('MUTATION TARGET — a key of an object literal names nothing', () => {
        expect(inEntry('<% const o = { fetch: 1, document: 2, extensionSettings: 3 }; %>')).toEqual(NOTHING);
    });
    it('MUTATION TARGET — SillyTavern on this chat, its interface, and the reads of its objects', () => {
        expect(inEntry('<% SillyTavern.saveChat(); SillyTavern.deleteMessage(3); SillyTavern.swipe.right(); SillyTavern.selectCharacterById(1); await SillyTavern.callGenericPopup(t) %>')).toEqual(NOTHING);
        expect(inEntry('<% const p = SillyTavern.getContext().getPresetManager().getSelectedPresetName() || ""; SillyTavern.variables.local.set("k", 1); SillyTavern.libs.lodash.get(o, p) %>')).toEqual(NOTHING);
    });
    it('mvu-helper\'s own globals and School\'s reads', () => {
        expect(inEntry('<%_ if (globalThis.MvuHelper && MvuHelper.settings && MvuHelper.settings.get("debug.pipeline") === true) { _%> x <%_ } _%>')).toEqual(NOTHING);
        expect(inEntry('<% const d = globalThis.mvuHelperExtraCallRenderDepth; const g = globalThis.mvuHelperIsGenerationInFlight; await LogicEngine.initiativeMenu(sd) %>')).toEqual(NOTHING);
        expect(inEntry('<% const v = (typeof TavernHelper !== "undefined") ? TavernHelper.getVariables({ type: "character" }) : {}; %>')).toEqual(NOTHING);
    });
    it('reports each find once, in the order first found, across every text', () => {
        expect(templateReachIn({ entries: ['<% fetch(1); document.x %>', '<% fetch(2) %>'], regexReplacements: ['<% eval(s) %>'] }))
            .toEqual({ settings: [], beyondChat: ['fetch', 'document', 'eval'], unchecked: [] });
    });
});

describe('every TavernHelper member to its class (W2)', () => {
    const { reads, thisChat, variables, settings, beyondChat } = TAVERN_HELPER_MEMBER_CLASSES;
    it('the classes are disjoint, and hold the 157 members TavernHelper 4.8.14 returns', () => {
        const all = [reads, thisChat, variables, settings, beyondChat].flat();
        expect(new Set(all).size).toBe(all.length);
        expect(all.length).toBe(157);
    });
    it('MUTATION TARGET — every read and every call on this chat passes (A, B, C2)', () => {
        for (const name of [...reads, ...thisChat]) expect(inEntry('<% TavernHelper.' + name + '() %>'), name).toEqual(NOTHING);
    });
    it('MUTATION TARGET — every C1 call is settings', () => {
        for (const name of settings) expect(inEntry('<% TavernHelper.' + name + '() %>'), name).toEqual({ ...NOTHING, settings: ['TavernHelper.' + name] });
    });
    it('MUTATION TARGET — every C3 and D call is beyond this chat', () => {
        for (const name of beyondChat) expect(inEntry('<% TavernHelper.' + name + '() %>'), name).toEqual({ ...NOTHING, beyondChat: ['TavernHelper.' + name] });
    });
    it('every variable function passes with this chat\'s store and warns with the extension store', () => {
        for (const name of variables) {
            const optionFirst = name === 'getVariables';
            const call = (option) => '<% TavernHelper.' + name + '(' + (optionFirst ? option : 'value, ' + option) + ') %>';
            expect(inEntry(call('{ type: "chat" }')), name).toEqual(NOTHING);
            expect(inEntry(call('{ type: "extension" }')).settings, name).toEqual(['TavernHelper.' + name + '({ type: \'extension\' })']);
        }
    });
});

describe('every SillyTavern member to its class (Appendix B)', () => {
    const { reads, thisChat, pageInterface, settings, beyondChat, objects } = SILLYTAVERN_MEMBER_CLASSES;
    // Reported by their own name wherever they appear, so a SillyTavern member of that name adds nothing.
    const REPORTED_BY_OWN_NAME = new Set(['extensionSettings', 'chatCompletionSettings', 'textCompletionSettings', 'powerUserSettings',
        'accountStorage', 'getRequestHeaders', 'ConnectionManagerRequestService']);
    const labelOf = (name) => (REPORTED_BY_OWN_NAME.has(name) ? name : 'SillyTavern.' + name);
    it('the classes are disjoint, and hold the 146 members SillyTavern 1.19.0\'s getContext() returns', () => {
        const all = [reads, thisChat, pageInterface, settings, beyondChat, Object.keys(objects).filter((name) => name !== 'libs')].flat();
        expect(new Set(all).size).toBe(all.length);
        expect(all.length).toBe(146);
    });
    it('MUTATION TARGET — every read, every member on this chat and the interface passes', () => {
        for (const name of [...reads, ...thisChat, ...pageInterface]) {
            expect(inEntry('<% SillyTavern.' + name + '() %>'), name).toEqual(NOTHING);
            expect(inEntry('<% SillyTavern.getContext().' + name + ' %>'), name).toEqual(NOTHING);
        }
    });
    it('MUTATION TARGET — every C1 member is settings', () => {
        for (const name of settings) expect(inEntry('<% SillyTavern.' + name + '() %>'), name).toEqual({ ...NOTHING, settings: [labelOf(name)] });
    });
    it('MUTATION TARGET — every C3 and D member is beyond this chat', () => {
        for (const name of beyondChat) expect(inEntry('<% SillyTavern.' + name + '() %>'), name).toEqual({ ...NOTHING, beyondChat: [labelOf(name)] });
    });
    it('MUTATION TARGET — an object\'s members report as their lists say, and one no list holds is beyond this chat', () => {
        for (const [object, classes] of Object.entries(objects)) {
            const reach = (member) => inEntry('<% SillyTavern.' + object + (object === 'getPresetManager' ? '()' : '') + '.' + member + '() %>');
            const label = (member) => 'SillyTavern.' + object + (object === 'getPresetManager' ? '()' : '') + '.' + member;
            for (const member of classes.allowed) expect(reach(member), object + '.' + member).toEqual(NOTHING);
            for (const member of classes.settings) expect(reach(member), object + '.' + member).toEqual({ ...NOTHING, settings: [label(member)] });
            for (const member of classes.beyondChat) expect(reach(member), object + '.' + member).toEqual({ ...NOTHING, beyondChat: [label(member)] });
            expect(reach('somethingNew'), object).toEqual({ ...NOTHING, beyondChat: [label('somethingNew')] });
        }
    });
    it('the preset manager holds the 19 methods of 1.19.0, libs the 25 libraries', () => {
        const count = (classes) => classes.allowed.length + classes.settings.length + classes.beyondChat.length;
        expect(count(objects.getPresetManager)).toBe(19);
        expect(count(objects.libs)).toBe(25);
    });
});

// ── the tokenizer against acorn's ────────────────────────────────────────────
// acorn's tokens, in the shape templateCodeTokens gives: keywords are names, backticks are dropped (a template's
// chunks and its `${`/`}` remain), and punctuation is its own text.
function acornTokens(source) {
    const tokens = [];
    for (const token of acorn.tokenizer(source, { ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true })) {
        const label = token.type.label;
        if (label === '`') continue;
        if (label === 'name' || token.type.keyword) tokens.push({ type: 'name', value: label === 'name' ? token.value : token.type.keyword });
        else if (label === 'string') tokens.push({ type: 'string', value: token.value });
        else if (label === 'template' || label === 'invalidTemplate') tokens.push({ type: 'template', value: token.value ?? '' });
        else if (label === 'num') tokens.push({ type: 'number', value: String(token.value) });
        else if (label === 'regexp') tokens.push({ type: 'regex', value: String(token.value) });
        else if (label === 'privateId') tokens.push({ type: 'private', value: token.value });
        else tokens.push({ type: 'punct', value: typeof token.value === 'string' && token.value ? token.value : label });
    }
    return tokens;
}

// What must agree: every name in order, every string and template chunk, and what the rules find.
function agreement(source) {
    const mine = templateCodeTokens(source);
    const theirs = acornTokens(source);
    const of = (tokens, type) => tokens.filter((token) => token.type === type).map((token) => token.value);
    const findsOf = (tokens) => {
        const found = { settings: new Set(), beyondChat: new Set(), unchecked: new Set() };
        addTemplateReach(tokens, found);
        return { settings: [...found.settings], beyondChat: [...found.beyondChat], unchecked: [...found.unchecked] };
    };
    return {
        names: [of(mine, 'name'), of(theirs, 'name')],
        strings: [of(mine, 'string').concat(of(mine, 'template')), of(theirs, 'string').concat(of(theirs, 'template'))],
        finds: [findsOf(mine), findsOf(theirs)],
    };
}

// Every case above that is valid JavaScript once EJS has compiled it, and a few that only a tokenizer cares about.
const TOKENIZER_CASES = [
    '<% fetch(1) %>', '<%= document.title %>', '<% var x = `%>${fetch(\'/x\')}<% ` %>',
    '<% const s = "TavernHelper.deleteWorldbook(x); fetch(1)"; %>', '<% // fetch(1)\n/* document */ const a = 1; %>',
    '<% \\u0066etch(1) %>', '<% if (a) /\'/.test(b); fetch(1) %>', '<% const r = a / b; const s = c / 2; fetch(1) %>',
    '<% const t = `a ${ `b ${ document.title }` } c`; %>', '<% setvar("x", 1, "\\x67lobal") %>',
    '<% TavernHelper.getVariables({ ...option, type: "chat" }) %>', '<% TavernHelper.getVariables({ get type() { return "global"; } }) %>',
    '<% [].constructor.constructor("return 1")() %>', '<% 1..constructor.constructor("x")() %>', '<% x = a?.b ?? c ? .5 : d?.[e]?.(f) %>',
    '<% const o = { a: 1 } / 2; while (x) /re/g.exec(y); for (;;) { } /x/.test(z) %>', '<% label: { break label; } const n = 0x1F + 1e-3 + 10n + 1_000; %>',
    '<% const re = /[/]+\\/x/gi; const t = `\\${not}`; class A { #p = 1; get #q() { return this.#p; } } %>',
    '<% const été = 1; const 名前 = "x"; %>',
    '<% SillyTavern.getContext().getPresetManager(api ?? "openai").savePreset(`${n}`); SillyTavern.variables?.global?.set("k", [1, { a: 2 }]) %>',
    '<%_ if (globalThis.MvuHelper && MvuHelper.settings && MvuHelper.settings.get("debug.pipeline") === true) { _%> x <%_ } _%>',
];

describe('the tokenizer agrees with acorn', () => {
    it.each(TOKENIZER_CASES)('%s', (text) => {
        const { names, strings, finds } = agreement(ejsSourceOf(text));
        expect(names[0]).toEqual(names[1]);
        expect(strings[0]).toEqual(strings[1]);
        expect(finds[0]).toEqual(finds[1]);
    });
});

// ── School's workspace: what ArtificKoi's packs install ──────────────────────
// What an install of School's two artifacts writes, as the install warning reads it (packReachTexts, menuReachTexts).
function schoolInstallTexts() {
    return [['gamelogic', packReachTexts], ['statusmenu', menuReachTexts]].map(([name, reachTextsOf]) => {
        const artifact = schoolv4Artifact(name);
        expect(artifact, 'School\'s ' + name + ' artifact').not.toBe(null);
        return reachTextsOf(artifact.pack);
    });
}

describe.skipIf(!haveSchoolv4())('School\'s workspace', () => {
    it('reaches nothing: installing ArtificKoi\'s packs asks nothing', () => {
        for (const texts of schoolInstallTexts()) expect(templateReachIn(texts)).toEqual(NOTHING);
    });
    it('carries template code to read (the scan is not running on nothing)', () => {
        expect(schoolInstallTexts()[0].entries.filter((entry) => entry.includes('<%')).length).toBeGreaterThan(30);
    });
    it('its every text tokenizes as acorn does', () => {
        for (const { entries, regexReplacements } of schoolInstallTexts()) {
            for (const text of [...entries, ...regexReplacements].filter((t) => t.includes('<%'))) {
                const { names, strings, finds } = agreement(ejsSourceOf(text));
                expect(names[0]).toEqual(names[1]);
                expect(strings[0]).toEqual(strings[1]);
                expect(finds[0]).toEqual(finds[1]);
            }
        }
    });
});
