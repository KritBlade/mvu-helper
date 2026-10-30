// tests/pack-install-warning-core.test.js — the install warning (plans/pack-install-warning.md §3, §4; W3, W4): the
// texts it reads from what each lane's install writes, the question a pack's reach asks, the warn line that records the
// answer, and how the installs ask (source gates: those files import SillyTavern's popup and cannot load here).
//
// MUTATION (run by hand, recorded): read no keys, no secondary keys or no trim strings, or read a row's find pattern →
// a texts test fails; read a menu row as shipped rather than lifted, or a plugin's rows → a lane test fails; ask with
// nothing found → the no-reach test fails; drop a kind's line, the cap or its count → the question tests fail; drop the
// icon or the danger button → the headline or button test fails; name only the shown finds in the log, or the wrong
// answer → the log tests fail; ask before the scan, skip the warn line, or answer yes on a failed scan or an unreadable
// pack → a source gate fails; ask after a handler's first step, write a pack outside an asking handler, route Repair or
// Upgrade around the ask, or ask in the dev loop → a handler gate fails.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { installReachTexts, hasPackReach, packReachQuestion, packReachLogLine, PACK_REACH_QUESTION_BUTTONS } from '../src/shared/pack-install-warning-core.js';
import { templateReachIn } from '../src/shared/template-reach.js';
import { wrapRenderedRegion } from '../src/shared/rendered-region.js';
import { packReachTexts } from '../src/features/gamelogic-pack/gamelogic-pack-core.js';
import { pluginReachTexts } from '../src/features/gamelogic-plugin/gamelogic-plugin-core.js';
import { menuReachTexts } from '../src/features/statusmenu-pack/statusmenu-pack-core.js';
import { dialogLineText } from '../src/sillytavern/popup-core.js';

const NOTHING = { settings: [], beyondChat: [], unchecked: [] };
const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r/g, '');
const asText = (lines) => lines.map(dialogLineText);

// A function's body in a source file: from its signature to the `}` that closes it at the start of a line.
function bodyOf(source, signature) {
    const start = source.indexOf(signature);
    expect(start, signature).toBeGreaterThan(-1);
    return source.slice(start + signature.length, source.indexOf('\n}\n', start));
}
// The body's lines as written, blank and comment lines dropped.
const statementLines = (body) => body.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('//'));

describe('what the warning reads of an install', () => {
    it('MUTATION TARGET — an entry\'s content and a row\'s replacement; for macros, its keys, secondary keys and trim strings', () => {
        expect(installReachTexts({
            entries: [{ content: 'a', keys: ['k1'], filters: ['f1'] }, { content: 'b' }],
            regexRows: [{ replace_string: 'r', trim_strings: ['t1'], find_regex: '/x/' }],
        })).toEqual({ entries: ['a', 'b'], regexReplacements: ['r'], macroTexts: ['k1', 'f1', 't1'] });
    });
    it('MUTATION TARGET — a row\'s find pattern is not read: every row is written with the macro option off', () => {
        expect(templateReachIn(installReachTexts({ regexRows: [{ find_regex: '/{{setglobalvar::x::1}}/', replace_string: '' }] }))).toEqual(NOTHING);
    });
    it('a macro in a secondary key reports', () => {
        expect(templateReachIn(installReachTexts({ entries: [{ content: '', filters: ['{{getglobalvar::a}}'] }] })).settings).toEqual(['{{getglobalvar::…}}']);
    });
    it('what is not an entry or a row is skipped, and a missing text reads as empty', () => {
        expect(installReachTexts({ entries: [null, 'x', { keys: 'k' }], regexRows: [7, {}] })).toEqual({ entries: [''], regexReplacements: [''], macroTexts: [] });
        expect(installReachTexts()).toEqual({ entries: [], regexReplacements: [], macroTexts: [] });
    });
});

describe('what each lane hands the warning', () => {
    const FENCE = String.fromCharCode(96).repeat(3);
    const reachingDocument = '<!DOCTYPE html>\n<html><body><% fetch(1) %>{{setglobalvar::a::1}}</body></html>';
    const fencedRow = (name) => ({ script_name: name, find_regex: '<StatusPlaceHolderImpl/>', replace_string: wrapRenderedRegion('statusmenu', FENCE + '\n' + reachingDocument + '\n' + FENCE) });

    it('MUTATION TARGET — a GameLogic Pack: its entries and its regex rows, and not its panel', () => {
        const pack = { entries: [{ content: 'e', keys: ['k'], filters: ['f'] }], regex: [{ replace_string: 'r', trim_strings: ['t'] }], panel: { title: '<% fetch(1) %>' } };
        expect(packReachTexts(pack)).toEqual({ entries: ['e'], regexReplacements: ['r'], macroTexts: ['k', 'f', 't'] });
    });
    it('MUTATION TARGET — a plugin: its entries, which are all it writes', () => {
        const plugin = { entries: [{ content: 'e', keys: ['k'] }], regex: [{ replace_string: 'never written' }] };
        expect(pluginReachTexts(plugin)).toEqual({ entries: ['e'], regexReplacements: [], macroTexts: ['k'] });
    });
    it('MUTATION TARGET — a StatusMenu Pack: a fenced row as the card gets it, its document lifted out and its name in the marker', () => {
        const plain = { script_name: 'plain', find_regex: 'x', replace_string: '<% fetch(1) %>' };
        const texts = menuReachTexts({ id: 'menu', regex: [fencedRow('{{setglobalvar::n::1}}'), plain] });
        expect(texts.regexReplacements[0]).not.toContain('<%');
        expect(texts.regexReplacements[0]).toContain('{{setglobalvar::n::1}}');
        expect(texts.regexReplacements[1]).toBe(plain.replace_string);
        expect(templateReachIn(texts)).toEqual({ settings: ['{{setglobalvar::…}}'], beyondChat: ['fetch'], unchecked: [] });
    });
    it('a StatusMenu Pack whose rows cannot be lifted is read as shipped', () => {
        const bare = { script_name: 'bare', find_regex: 'x', replace_string: FENCE + '\n<% fetch(1) %>\n' + FENCE };
        expect(menuReachTexts({ id: 'menu', regex: [bare] }).regexReplacements).toEqual([bare.replace_string]);
    });
});

describe('whether there is anything to ask', () => {
    it('MUTATION TARGET — nothing found, or no reach at all, asks nothing', () => {
        expect(hasPackReach(NOTHING)).toBe(false);
        expect(hasPackReach(undefined)).toBe(false);
        expect(hasPackReach({})).toBe(false);
    });
    it('any one kind found asks', () => {
        expect(hasPackReach({ ...NOTHING, settings: ['extensionSettings'] })).toBe(true);
        expect(hasPackReach({ ...NOTHING, beyondChat: ['fetch'] })).toBe(true);
        expect(hasPackReach({ ...NOTHING, unchecked: ['TavernHelper[…]'] })).toBe(true);
    });
});

describe('the question', () => {
    it('MUTATION TARGET — the danger headline first, then the pack, each kind found, the question and the two answers', () => {
        const lines = packReachQuestion({
            packName: 'weather', version: '1.2.0',
            reach: { settings: ['extensionSettings'], beyondChat: ['TavernHelper.deleteWorldbook', 'execute'], unchecked: ['TavernHelper[…]'] },
        });
        expect(lines[0]).toEqual({ text: 'This pack can reach outside the game.', icon: 'fa-circle-exclamation' });
        expect(asText(lines)).toEqual([
            'This pack can reach outside the game.',
            'weather v1.2.0',
            'It has code that can access Extension settings, which can read or change your SillyTavern settings: extensionSettings',
            'It has code that can change SillyTavern outside this chat: TavernHelper.deleteWorldbook, execute',
            'It uses TavernHelper, SillyTavern or the page in a way MVU Helper cannot check: TavernHelper[…]',
            'Are you sure you REALLY want to install this pack?',
            'Install anyway: the pack is installed, and this code runs as you play.',
            'Cancel: nothing is installed or changed.',
        ]);
    });
    it('MUTATION TARGET — only the kinds found get a line', () => {
        const lines = asText(packReachQuestion({ packName: 'weather', reach: { ...NOTHING, beyondChat: ['fetch'] } }));
        expect(lines).toEqual([
            'This pack can reach outside the game.',
            'weather',
            'It has code that can change SillyTavern outside this chat: fetch',
            'Are you sure you REALLY want to install this pack?',
            'Install anyway: the pack is installed, and this code runs as you play.',
            'Cancel: nothing is installed or changed.',
        ]);
    });
    it('MUTATION TARGET — a line names at most five finds, then how many more', () => {
        const finds = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
        const [, , line] = packReachQuestion({ packName: 'x', reach: { ...NOTHING, settings: finds } });
        expect(line.name).toBe('a, b, c, d, e (+2)');
        const [, , five] = packReachQuestion({ packName: 'x', reach: { ...NOTHING, settings: finds.slice(0, 5) } });
        expect(five.name).toBe('a, b, c, d, e');
    });
    it('MUTATION TARGET — the action is Install anyway, drawn red', () => {
        expect(PACK_REACH_QUESTION_BUTTONS).toEqual({ okButton: 'Install anyway', isDanger: true });
    });
    it('a pack with no name still reads', () => {
        expect(dialogLineText(packReachQuestion({ reach: { ...NOTHING, settings: ['x'] } })[1])).toBe('?');
    });
});

describe('the warn line', () => {
    const reach = { settings: ['a', 'b', 'c', 'd', 'e', 'f'], beyondChat: [], unchecked: ['window[…]'] };
    it('MUTATION TARGET — names the pack, every find by kind (past the five a line shows) and the answer', () => {
        expect(packReachLogLine({ packName: 'weather', version: '1.2.0', reach, isInstalled: true })).toBe(
            'warned before installing weather v1.2.0, which can reach outside the game (settings: a, b, c, d, e, f; unchecked: window[…]) — the user answered Install anyway');
    });
    it('MUTATION TARGET — a cancel reads as one', () => {
        expect(packReachLogLine({ packName: 'weather', reach, isInstalled: false })).toMatch(/— the user answered Cancel$/);
    });
});

describe('how the warning asks (source gates)', () => {
    const source = read('src/shared/pack-install-warning.js');
    const body = source.slice(source.indexOf('export async function confirmPackReach'));
    it('MUTATION TARGET — it scans first, and asks only when the scan found something', () => {
        const scan = body.indexOf('templateReachIn(texts)');
        const gate = body.indexOf('if (!hasPackReach(reach)) return true;');
        const ask = body.indexOf('confirmPopup(packReachQuestion(');
        expect(scan).toBeGreaterThan(-1);
        expect(gate).toBeGreaterThan(scan);
        expect(ask).toBeGreaterThan(gate);
    });
    it('MUTATION TARGET — every asked install leaves one warn line with the answer, and answers with it', () => {
        expect(body).toMatch(/const isInstalled = !!\(await confirmPopup\(packReachQuestion\(\{ packName, version, reach \}\), PACK_REACH_QUESTION_BUTTONS\)\);\n\s*log\.warn\(packReachLogLine\(\{ packName, version, reach, isInstalled \}\)\);\n\s*return isInstalled;/);
    });
    it('MUTATION TARGET — a scan that fails says so and answers no', () => {
        const failure = body.slice(body.indexOf('} catch (e) {'), body.indexOf('if (!hasPackReach'));
        expect(failure).toMatch(/return refuseUncheckedPack\(packName, e\);/);
        const refusal = bodyOf(source, 'export async function refuseUncheckedPack(packName, reason) {');
        expect(refusal).toMatch(/log\.error\([^;]*, reason\);/);
        expect(refusal).toMatch(/noticePopup\(/);
        expect(statementLines(refusal).at(-1)).toBe('return false;');
        expect(refusal).not.toMatch(/return true/);
    });
    it('MUTATION TARGET — a library pack that cannot be read, or read into texts, answers no; one that can is scanned', () => {
        const ask = bodyOf(read('src/features/gamelogic-pack/library-pack-reach.js'), 'export async function confirmLibraryPackReach(packType, id, reachTextsOf) {');
        expect(ask).toMatch(/if \(!pack\) return refuseUncheckedPack\(id, /);
        expect(ask).toMatch(/try \{\n\s*texts = reachTextsOf\(pack\);\n\s*\} catch \(e\) \{\n\s*return refuseUncheckedPack\(id, e\);\n\s*\}/);
        expect(statementLines(ask).at(-1)).toBe("return confirmPackReach({ packName: String(pack.name || id), version: String(pack.version || ''), texts });");
    });
});

describe('every install asks first (source gates)', () => {
    // [file, the asking handler, its first statement, the calls that write the pack, the functions allowed to make them]
    const lanes = [
        ['src/features/gamelogic-pack/gamelogic-pack-ui.js', 'async function onInstallFromLibrary(id) {',
            "if (!await confirmLibraryPackReach('gamelogic', id, packReachTexts)) return;", /\b(?:activatePack|switchToPack)\(/g, ['async function installToCard(id) {']],
        ['src/features/gamelogic-plugin/gamelogic-plugin-ui.js', 'export async function onInstallPluginFromLibrary(id) {',
            'if (!await confirmLibraryPackReach(PLUGIN_TYPE, id, pluginReachTexts)) return;', /\binstallPlugin\(/g, ['export async function onInstallPluginFromLibrary(id) {']],
        ['src/features/statusmenu-pack/statusmenu-pack-ui.js', 'export async function onInstallMenuFromLibrary(id) {',
            'if (!await confirmLibraryPackReach(STATUSMENU_TYPE, id, menuReachTexts)) return;', /\bactivateMenu\(/g, ['export async function onInstallMenuFromLibrary(id) {']],
    ];
    it('MUTATION TARGET — each lane\'s install handler asks before any other question or write', () => {
        for (const [file, handler, ask] of lanes) expect(statementLines(bodyOf(read(file), handler))[0], file).toBe(ask);
    });
    it('MUTATION TARGET — in each lane\'s tab, the pack is written only behind its asking handler', () => {
        for (const [file, , , writes, allowed] of lanes) {
            const source = read(file);
            const ranges = allowed.map((signature) => {
                const start = source.indexOf(signature);
                return [start, source.indexOf('\n}\n', start)];
            });
            const outside = [...source.matchAll(writes)].filter((match) => !ranges.some(([from, to]) => match.index > from && match.index < to));
            expect(outside.map((match) => match[0]), file).toEqual([]);
        }
    });
    it('MUTATION TARGET — the GameLogic card row\'s Repair and Upgrade go through the asking handler, which alone installs', () => {
        const source = read('src/features/gamelogic-pack/gamelogic-pack-ui.js');
        expect(source).toContain("if (action === 'install') void onInstallFromLibrary($(this).attr('data-gp-id'));");
        expect([...source.matchAll(/\binstallToCard\(/g)]).toHaveLength(2);
        expect(statementLines(bodyOf(source, 'async function onInstallFromLibrary(id) {')).at(-1)).toBe('await installToCard(id);');
    });
    it('MUTATION TARGET — the dev loop\'s lanes never ask', () => {
        expect(read('src/index.js')).not.toMatch(/confirmLibraryPackReach|confirmPackReach/);
    });
});
