/**
 * MVU Helper — the card gate (devdoc/gui-dna.md §7): per-card settings live in the card's profile, and in
 * SillyTavern's lobby there is no card to keep them.
 *   G11  a panel handler that reads the card profile, writes the card's lorebook, or saves the chat's state targets an
 *        element that is, or sits inside, a data-mvuh-needs region — or, delegated, fires only on declared controls;
 *        every function in src that
 *        calls getProfile is listed here, so a new accessor cannot slip past; an install reached through the artifact
 *        lane table counts as the write it is
 *   D11  the copy getProfile answers in the lobby is frozen, and every accessor runs against it without writing
 * The gate's one decision (isNeedUnmet) is tested beside the builders, in gui-dna-core.test.js.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsFilesUnder, codeOnly } from './code-scan.mjs';
import { profileRecordFor, fillMissingDefaults } from '../src/sillytavern/settings-store-core.js';
import { isNeedUnmet } from '../src/features/settings-panel/gui-dna-core.js';
import { imagegenProfileDefaults, imagegenProfileOf } from '../src/features/imagegen/imagegen-profile-core.js';
import { rosterProfileDefaults, rosterProfileOf } from '../src/features/character-roster/roster-settings-core.js';
import { logicEngineProfileDefaults, logicEngineProfileOf } from '../src/features/logic-engine/logic-engine-core.js';
import { leadTextProfileDefaults, storyEnvelopeOf } from '../src/features/logic-engine/turn-runner-core.js';
import { sidePanelProfileDefaults, sidePanelSettingsOf } from '../src/features/side-panel/side-panel-core.js';
import { statBoxProfileDefaults, statBoxSectionOf } from '../src/features/statbox/statbox-core.js';
import { extraLlmCallsDefaults, extraLlmCallsOf } from '../src/features/small-llm/extra-llm-calls-core.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const SETTINGS_HTML = path.join(SRC, 'features', 'settings-panel', 'settings.html');
const read = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');

// ── The profile's readers ────────────────────────────────────────────────────────────────────────────────────────
// The template src/index.js hands loadSettings, piece by piece.
const TEMPLATE_PARTS = {
    extraLlmCallsDefaults, imagegenProfileDefaults, rosterProfileDefaults, logicEngineProfileDefaults, leadTextProfileDefaults,
    statBoxProfileDefaults, sidePanelProfileDefaults,
};
const TEMPLATE = Object.assign({}, ...Object.values(TEMPLATE_PARTS));

// Every function in src that calls getProfile. An accessor hands the profile to its pure counterpart, which the lobby's
// frozen copy runs below.
const PROFILE_ACCESSORS = [
    { file: 'src/features/imagegen/image-gen.js', name: 'getImagegenProfile', pure: imagegenProfileOf, answer: (p) => p.imagegen },
    { file: 'src/features/character-roster/roster-settings.js', name: 'getRosterProfile', pure: rosterProfileOf, answer: (p) => p.roster },
    { file: 'src/features/logic-engine/logic-engine-store.js', name: 'getLogicEngineProfile', pure: logicEngineProfileOf, answer: (p) => p.logicEngine },
    { file: 'src/features/logic-engine/logic-engine-store.js', name: 'getStoryEnvelope', pure: storyEnvelopeOf, answer: () => null },
    { file: 'src/features/side-panel/side-panel.js', name: 'sidePanelSettings', pure: sidePanelSettingsOf, answer: (p) => p.sidePanel },
    { file: 'src/features/statbox/statbox.js', name: 'activeSection', pure: statBoxSectionOf, answer: () => null },
    { file: 'src/features/small-llm/extra-llm-calls.js', name: 'getExtraLlmCallsProfile', pure: extraLlmCallsOf, answer: (p) => p.extraLlmCalls },
];
// The two that read the whole record never run in the lobby.
const CARD_OPEN_READERS = [
    { file: 'src/features/card-config/card-config.js', name: 'importCardConfig', why: 'it reads the profile only once hasActiveCharacter() says a card is open' },
    { file: 'src/features/card-config/card-config.js', name: 'exportCardConfig', why: "Export to card sits in Main's Card config card, which needs a card" },
];
const PROFILE_READERS = [...PROFILE_ACCESSORS, ...CARD_OPEN_READERS];

// ── Source units: every src file's functions and imports ────────────────────────────────────────────────────────
function closingBracket(code, open) {
    const closers = { '(': ')', '{': '}', '[': ']' };
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        if (closers[code[i]]) depth++;
        else if (')}]'.includes(code[i]) && --depth === 0) return i;
    }
    return code.length - 1;
}

// The top-level arguments of the call whose '(' is at `open`, as [start, end) spans.
function argumentSpans(code, open) {
    const end = closingBracket(code, open);
    const spans = [];
    let depth = 0, start = open + 1;
    for (let i = open + 1; i < end; i++) {
        if ('([{'.includes(code[i])) depth++;
        else if (')]}'.includes(code[i])) depth--;
        else if (code[i] === ',' && depth === 0) { spans.push([start, i]); start = i + 1; }
    }
    if (code.slice(start, end).trim()) spans.push([start, end]);
    return spans;
}

// Where an arrow's expression body ends: the first ';' (or an unbalanced closer) at its own depth.
function expressionEnd(code, from) {
    let depth = 0;
    for (let i = from; i < code.length; i++) {
        if ('([{'.includes(code[i])) depth++;
        else if (')]}'.includes(code[i])) { if (depth === 0) return i - 1; depth--; }
        else if (code[i] === ';' && depth === 0) return i;
    }
    return code.length - 1;
}

const FUNCTION_DECLARATION = /^([ \t]*)(export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(/gm;
const FUNCTION_BINDING = /^([ \t]*)(export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(function\b[^(]*\(|\(|[\w$]+\s*=>)/gm;

// Every function in a file, at any depth: { name, start, end, body, params, isExported }. A nested helper is never exported.
function functionsIn(code) {
    const found = [];
    for (const match of code.matchAll(FUNCTION_DECLARATION)) {
        const paramsOpen = match.index + match[0].length - 1;
        const paramsClose = closingBracket(code, paramsOpen);
        const end = closingBracket(code, code.indexOf('{', paramsClose));
        found.push({ match, paramsOpen, paramsClose, end });
    }
    for (const match of code.matchAll(FUNCTION_BINDING)) {
        const head = match.index + match[0].length;
        let paramsOpen = -1, paramsClose = -1, arrowAt;
        if (match[4].endsWith('(')) {
            paramsOpen = head - 1;
            paramsClose = closingBracket(code, paramsOpen);
            const after = code.slice(paramsClose + 1).match(/^\s*=>\s*/);
            if (!match[4].startsWith('function') && !after) continue;   // `const x = (a + b) * 2` is no function
            arrowAt = after ? paramsClose + 1 + after[0].length : -1;
        } else arrowAt = head;
        const isBlock = arrowAt < 0 || code[arrowAt] === '{';
        const end = isBlock ? closingBracket(code, code.indexOf('{', arrowAt < 0 ? paramsClose : arrowAt)) : expressionEnd(code, arrowAt);
        found.push({ match, paramsOpen, paramsClose, end, singleParam: match[4].endsWith('=>') ? match[4].replace(/\s*=>$/, '') : null });
    }
    return found.map(({ match, paramsOpen, paramsClose, end, singleParam }) => ({
        name: match[3],
        start: match.index,
        end,
        body: code.slice(match.index, end + 1),
        params: singleParam ? [singleParam] : paramsOpen < 0 ? [] : code.slice(paramsOpen + 1, paramsClose).split(',').map((p) => p.trim().split(/[\s=]/)[0]).filter(Boolean),
        isExported: Boolean(match[2]) && match[1] === '',
        isTopLevel: match[1] === '',
    }));
}

const bindingsOf = (list) => list.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [imported, local] = part.split(/\s+as\s+/);
    return { imported: imported.trim(), local: (local || imported).trim() };
});
const IMPORT_LIST = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm;
const RE_EXPORT_LIST = /^export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm;

const UNITS = new Map(jsFilesUnder(SRC).map((file) => {
    const text = read(file);
    const code = codeOnly(text);
    const key = relative(file);
    const resolveSpecifier = (specifier) => (specifier.startsWith('.') ? relative(path.resolve(path.dirname(file), specifier)) : null);
    const imports = new Map();
    for (const match of text.matchAll(IMPORT_LIST)) for (const b of bindingsOf(match[1])) imports.set(b.local, { from: resolveSpecifier(match[2]), imported: b.imported });
    const reExports = new Map();
    for (const match of text.matchAll(RE_EXPORT_LIST)) for (const b of bindingsOf(match[1])) reExports.set(b.local, { from: resolveSpecifier(match[2]), imported: b.imported });
    const functions = functionsIn(code);
    const byName = new Map();
    for (const fn of [...functions].sort((a, b) => Number(b.isTopLevel) - Number(a.isTopLevel))) if (!byName.has(fn.name)) byName.set(fn.name, fn);
    return [key, { key, text, code, imports, reExports, functions, byName }];
}));

// The function a name exported from `fileKey` really is, through any barrel's re-exports.
function definitionOf(fileKey, name, depth = 0) {
    const unit = UNITS.get(fileKey);
    if (!unit || depth > 8) return null;
    const own = unit.byName.get(name);
    if (own && own.isTopLevel) return { file: fileKey, name };
    const reExport = unit.reExports.get(name);
    return reExport ? definitionOf(reExport.from, reExport.imported, depth + 1) : null;
}
const keyOf = ({ file, name }) => `${file} ${name}`;

const CALL = /(?<![\w$.])([\w$]+)\s*\(/g;
const NOT_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new', 'void', 'async', '$']);

// A lorebook write with no book name goes to the card's own book; a book name means another (the library). The value is
// the index of the book argument — a call with fewer arguments writes the card.
const LOREBOOK = 'src/sillytavern/lorebook.js';
const BOOK_ARGUMENT = { upsertLorebookEntry: 3, upsertLorebookEntryFields: 2, deleteLorebookEntriesByNeedle: 1, setPrimaryLorebook: Infinity };
// The save door writes a message's state in the open chat — the card's chat — so a panel handler that reaches it needs
// a card as much as one that writes the card's lorebook (the Roster tab's edits, which keep the character registry there).
const SAVE_DOOR = { file: 'src/sillytavern/mvu-bridge.js', name: 'saveMessageMvuData' };

// The artifact tabs install through a lane table (gamelogic-pack/artifact-tabs-ui.js): `lanes.get(type).install(id)`, a
// method call no name scan can follow. Each install handed to registerArtifactLane is read where it is registered
// (registeredLaneInstalls), and a call through the table reaches LANE_INSTALL, a card write when any of them is one.
const LANE_TABLE = { file: 'src/features/gamelogic-pack/artifact-tabs-ui.js', register: 'registerArtifactLane' };
const LANE_INSTALL = { file: LANE_TABLE.file, name: 'a registered lane install' };
const callsLaneInstall = (text) => [...text.matchAll(/(?<![\w$.])lanes\.get\(/g)]
    .some((match) => /^\s*\.\s*install\s*\(/.test(text.slice(closingBracket(text, match.index + match[0].length - 1) + 1)));

// What a body reaches: the functions it calls in other files or as exports (not followed), after following its own
// file's private helpers; and whether it writes the card's lorebook itself.
function reachOf(unit, body) {
    const reached = [];
    let writesCardBook = false;
    const followed = new Set();
    const queue = [body];
    while (queue.length) {
        const text = queue.shift();
        if (unit.key === LANE_TABLE.file && callsLaneInstall(text)) reached.push(LANE_INSTALL);
        for (const match of text.matchAll(CALL)) {
            const name = match[1];
            if (NOT_CALLS.has(name)) continue;
            const local = unit.byName.get(name);
            if (local && !local.isExported) {
                if (!followed.has(local)) { followed.add(local); queue.push(local.body); }
                continue;
            }
            const imported = unit.imports.get(name);
            const definition = local ? { file: unit.key, name } : imported && definitionOf(imported.from, imported.imported);
            if (!definition) continue;
            if (definition.file === LOREBOOK && name in BOOK_ARGUMENT) {
                const open = match.index + match[0].length - 1;
                if (argumentSpans(text, open).length <= BOOK_ARGUMENT[name]) writesCardBook = true;
            }
            if (definition.file === SAVE_DOOR.file && name === SAVE_DOOR.name) writesCardBook = true;
            reached.push(definition);
        }
    }
    return { reached, writesCardBook };
}

// Card writers: a top-level function that (with its file's private helpers) writes the card's lorebook, and one level
// of the functions in other files that call one — the store and its lane. A repaint further off is not one.
const DIRECT_WRITERS = new Set();
const CARD_WRITERS = new Set();
for (const unit of UNITS.values()) {
    if (unit.key === LOREBOOK) continue;
    for (const fn of unit.functions) if (fn.isTopLevel && reachOf(unit, fn.body).writesCardBook) DIRECT_WRITERS.add(keyOf({ file: unit.key, name: fn.name }));
}
for (const key of DIRECT_WRITERS) CARD_WRITERS.add(key);
for (const unit of UNITS.values()) {
    for (const fn of unit.functions) {
        if (fn.isTopLevel && reachOf(unit, fn.body).reached.some((d) => DIRECT_WRITERS.has(keyOf(d)))) CARD_WRITERS.add(keyOf({ file: unit.key, name: fn.name }));
    }
}

// The `install` of every registerArtifactLane call, as { file, text, writesCard }: its expression, read in the unit that
// registers it. The declaration itself destructures `{ install, installedIds }` and names no expression, so it is skipped.
function registeredLaneInstalls() {
    const installs = [];
    for (const unit of UNITS.values()) {
        for (const call of unit.code.matchAll(new RegExp(`(?<![\\w$.])${LANE_TABLE.register}\\s*\\(`, 'g'))) {
            const spans = argumentSpans(unit.code, call.index + call[0].length - 1);
            const lane = spans[1] && unit.code.slice(...spans[1]).trim();
            if (!lane || !lane.startsWith('{')) continue;
            const property = argumentSpans(lane, 0).map((span) => lane.slice(...span).trim()).find((part) => /^install\s*:/.test(part));
            if (!property) continue;
            const text = property.replace(/^install\s*:\s*/, '');
            const { reached, writesCardBook } = reachOf(unit, text);
            installs.push({ file: unit.key, text, writesCard: writesCardBook || reached.some((d) => CARD_WRITERS.has(keyOf(d))) });
        }
    }
    return installs;
}
const LANE_INSTALLS = registeredLaneInstalls();
if (LANE_INSTALLS.some((install) => install.writesCard)) CARD_WRITERS.add(keyOf(LANE_INSTALL));
const PROFILE_SOURCES = new Set(['src/sillytavern/settings-store.js getProfile', ...PROFILE_READERS.map(keyOf)]);

// What a handler touches on the card: the profile it reads, the lorebook it writes.
function cardTouches(unit, handlerText) {
    const { reached, writesCardBook } = reachOf(unit, handlerText);
    const profile = reached.find((d) => PROFILE_SOURCES.has(keyOf(d)));
    const book = reached.find((d) => CARD_WRITERS.has(keyOf(d)));
    return { profile: profile && profile.name, book: book ? book.name : (writesCardBook ? 'a lorebook write' : null) };
}

// ── Handlers bound by id ───────────────────────────────────────────────────────────────────────────────────────────
const ID_SELECTOR = /^(['"])((?:\s*#[\w-]+\s*,?)+)\1$/;
const idsIn = (selector) => selector.match(ID_SELECTOR)[2].split(',').map((part) => part.trim().slice(1)).filter(Boolean);

// A handler expression, as text; a bare identifier is a local function, or a parameter a wrapper is called with
// (`onAction('edit', function () {…})`), each call's argument a handler of its own. null: not readable.
function handlerTexts(unit, expressionStart, expression) {
    const name = expression.trim();
    if (!/^[\w$]+$/.test(name)) return [expression];
    const local = unit.byName.get(name);
    if (local) return [local.body];
    const enclosing = unit.functions.filter((fn) => fn.start <= expressionStart && expressionStart <= fn.end)
        .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    const index = enclosing ? enclosing.params.indexOf(name) : -1;
    if (index < 0) return null;
    const texts = [];
    for (const call of unit.code.matchAll(new RegExp(`(?<![\\w$.])${enclosing.name.replace(/\$/g, '\\$')}\\s*\\(`, 'g'))) {
        if (call.index === enclosing.start || unit.code.slice(enclosing.start, call.index + call[0].length).match(/^[\s\w]*(?:const|let|var|function)\s+[\w$]+\s*(?:=\s*(?:async\s*)?)?\($/)) continue;
        const spans = argumentSpans(unit.code, call.index + call[0].length - 1);
        if (spans[index]) texts.push(unit.code.slice(...spans[index]));
    }
    return texts;
}

// Each `.on(…)` in the method chain that starts at `after`.
function bindingsAt(unit, ids, after) {
    const found = [];
    let at = after;
    for (;;) {
        const link = unit.code.slice(at).match(/^\s*\.\s*([\w$]+)\s*\(/);
        if (!link) break;
        const open = at + link[0].length - 1;
        if (link[1] === 'on') {
            const spans = argumentSpans(unit.code, open);
            const last = spans[spans.length - 1];
            const delegated = spans.length >= 3 ? unit.text.slice(...spans[1]).trim() : null;
            const texts = handlerTexts(unit, last[0], unit.code.slice(...last));
            found.push({ file: unit.key, line: unit.code.slice(0, open).split('\n').length, ids, delegated, texts });
        }
        at = closingBracket(unit.code, open) + 1;
    }
    return found;
}

function handlersById() {
    const handlers = [];
    for (const unit of UNITS.values()) {
        for (const match of unit.code.matchAll(/(?<![\w$.])\$\(\s*['"]/g)) {
            const open = match.index + 1;
            const close = closingBracket(unit.code, open);
            const selector = unit.text.slice(open + 1, close).trim();
            if (ID_SELECTOR.test(selector)) handlers.push(...bindingsAt(unit, idsIn(selector), close + 1));
        }
        for (const match of unit.code.matchAll(/(?:const|let|var)\s+(\$?[\w$]+)\s*=\s*\$\(/g)) {
            const open = match.index + match[0].length - 1;
            const selector = unit.text.slice(open + 1, closingBracket(unit.code, open)).trim();
            if (!ID_SELECTOR.test(selector)) continue;
            const variable = match[1];
            const declaredAt = match.index + match[0].indexOf(variable);
            for (const use of unit.code.matchAll(new RegExp(`(?<![\\w$])${variable.replace(/\$/g, '\\$')}(?=\\s*\\.)`, 'g'))) {
                if (use.index !== declaredAt) handlers.push(...bindingsAt(unit, idsIn(selector), use.index + variable.length));
            }
        }
    }
    return handlers;
}

// ── The markup: which ids sit behind a declaration, and each page's notice ─────────────────────────────────────────
const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);
function markupScopes() {
    const html = read(SETTINGS_HTML).replace(/<!--[\s\S]*?-->/g, '');
    const gatedIds = new Map();
    const pages = [];
    const stack = [];
    for (const match of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
        const [, isClosing, rawTag, attributes] = match;
        const tag = rawTag.toLowerCase();
        if (isClosing) {
            while (stack.length && stack.pop().tag !== tag);
            continue;
        }
        const needs = (attributes.match(/\bdata-mvuh-needs="([^"]*)"/) || [])[1] || null;
        const isGated = Boolean(needs) || stack.some((open) => open.needs);
        const id = (attributes.match(/\bid="([^"]+)"/) || [])[1];
        if (id) gatedIds.set(id, isGated);
        const page = /\bclass="mvuh-page"/.test(attributes) ? { id, regions: 0, notices: [] } : null;
        if (page) pages.push(page);
        const currentPage = page || [...stack].reverse().find((open) => open.page)?.page;
        if (currentPage && needs) currentPage.regions++;
        const noticeFor = (attributes.match(/\bdata-mvuh-notice-for="([^"]*)"/) || [])[1];
        if (currentPage && noticeFor) currentPage.notices.push({ need: noticeFor, isGated });
        if (!VOID_TAGS.has(tag)) stack.push({ tag, needs, page });
    }
    return { gatedIds, pages, html };
}

describe('the card gate', () => {
    const { gatedIds, pages, html } = markupScopes();
    const handlers = handlersById();
    const touching = handlers.map((h) => ({ ...h, touches: (h.texts || []).map((t) => cardTouches(UNITS.get(h.file), t)) }));
    const touchOf = (id, delegatedPart = '') => touching.filter((h) => h.ids.includes(id) && (h.delegated || '').includes(delegatedPart));

    it('the scan sees what it must: profile reads, lorebook writes, a wrapper, a delegated declared selector, a global control', () => {
        expect(touchOf('mvuh_add_call')[0].touches[0].profile).toBe('getExtraLlmCallsProfile');
        expect(touchOf('mvuh_le_install')[0].touches[0].book).toBe('writeEngineCode');
        expect(touchOf('mvuh_roster_registry')[0].touches.some((t) => t.book === 'deleteCharDna')).toBe(true);
        expect(touchOf('mvuh_ep_library', 'library-install')[0].touches[0].book).toBeTruthy();
        // The lane table: the GameLogic Pack's, the plugin's and the menu's install are each read where they are registered.
        expect(LANE_INSTALLS.length).toBe(3);
        expect(LANE_INSTALLS.find((install) => install.file === 'src/features/gamelogic-pack/gamelogic-pack-ui.js').writesCard).toBe(true);
        expect(touchOf('mvuh_gp_list', 'install')[0].touches[0].book).toBe(LANE_INSTALL.name);
        expect(touchOf('mvuh_img_streaming')[0].touches[0]).toEqual({ profile: undefined, book: null });
        expect(touchOf('mvuh_export_config')[0].touches[0].profile).toBe('exportCardConfig');
        expect(gatedIds.get('mvuh_add_call')).toBe(true);
        expect(gatedIds.get('mvuh_img_streaming')).toBe(false);
    });

    it('G11 — a handler that reads the card profile or writes its lorebook sits behind a data-mvuh-needs declaration', () => {
        const unreadable = handlers.filter((h) => h.texts === null)
            .map((h) => `${h.file}:${h.line} #${h.ids.join(', #')} — its handler is neither a function nor a wrapper's parameter: G11 cannot read it`);
        const open = touching.flatMap((h) => {
            const touch = h.touches.find((t) => t.profile || t.book);
            if (!touch) return [];
            const isDeclaredSelector = Boolean(h.delegated) && h.delegated.split(',').every((part) => part.includes('[data-mvuh-needs'));
            const missing = h.ids.filter((id) => !gatedIds.has(id));
            if (missing.length) return [`${h.file}:${h.line} #${missing.join(', #')} touches the card but is not in settings.html, so its gate cannot be read`];
            if (h.ids.every((id) => gatedIds.get(id)) || isDeclaredSelector) return [];
            const what = touch.profile ? `reads the card profile (${touch.profile})` : `writes the card's lorebook (${touch.book})`;
            return [`${h.file}:${h.line} #${h.ids.join(', #')}${h.delegated ? ` ${h.delegated}` : ''} ${what} — put it inside a data-mvuh-needs region, or bind it to declared controls only`];
        });
        expect([...unreadable, ...open]).toEqual([]);
    });

    it('G11 — every function that calls getProfile is listed here, so a new accessor cannot slip past', () => {
        const callers = [];
        for (const unit of UNITS.values()) {
            if (unit.key === 'src/sillytavern/settings-store.js') continue;
            for (const fn of unit.functions) {
                if (fn.isTopLevel && /(?<![\w$.])getProfile\s*\(/.test(fn.body)) callers.push(keyOf({ file: unit.key, name: fn.name }));
            }
        }
        expect(callers.sort()).toEqual(PROFILE_READERS.map(keyOf).sort());
    });

    it('every accessor hands the live profile to its pure counterpart', () => {
        for (const accessor of PROFILE_ACCESSORS) {
            const fn = UNITS.get(accessor.file).byName.get(accessor.name);
            expect(fn.body, accessor.name).toMatch(new RegExp(`\\breturn\\s+${accessor.pure.name}\\(getProfile\\(\\)\\);`));
        }
    });

    it('a declaration names a need this build knows, in the markup and in every builder call', () => {
        const declared = [...html.matchAll(/data-mvuh-(?:needs|notice-for)="([^"]*)"/g)].map((m) => m[1]);
        for (const unit of UNITS.values()) declared.push(...[...unit.text.matchAll(/\bneeds:\s*['"]([^'"]*)['"]/g)].map((m) => m[1]));
        expect(declared.length).toBeGreaterThan(15);
        // A need this build knows is met once a card and its chat are open; an unknown one never is.
        expect(declared.filter((need) => isNeedUnmet(need, { isCardOpen: true, isChatStarted: true }))).toEqual([]);
    });

    it('every page with a declared region shows its notice, outside every region, so a screen reader still reaches it', () => {
        const gatedPages = pages.filter((page) => page.regions > 0);
        expect(gatedPages.map((page) => page.id)).toEqual(['mvuh_panel_main', 'mvuh_panel_image', 'mvuh_panel_roster', 'mvuh_panel_llm', 'mvuh_panel_events', 'mvuh_panel_logic', 'mvuh_panel_gamelogic', 'mvuh_panel_statusmenu', 'mvuh_panel_development']);
        for (const page of gatedPages) {
            expect(page.notices.length, page.id).toBe(1);
            expect(page.notices[0].isGated, page.id).toBe(false);
        }
    });
});

describe('the lobby profile copy (D11)', () => {
    it('the template here is the one src/index.js composes', () => {
        const source = read(path.join(SRC, 'index.js'));
        const call = source.match(/loadSettings\(\{[^}]*\},\s*\{([^}]*)\}\)/);
        expect(call).not.toBe(null);
        const parts = call[1].split(',').map((part) => part.trim().replace(/^\.\.\./, '')).filter(Boolean);
        expect(parts.sort()).toEqual(Object.keys(TEMPLATE_PARTS).sort());
    });

    it('MUTATION TARGET — every accessor reads the frozen lobby copy without writing to it', () => {
        const lobby = profileRecordFor({}, 'goten_sillytavern_system_xg9mp8', TEMPLATE, { isCardOpen: false });
        expect(Object.isFrozen(lobby.extraLlmCalls.calls)).toBe(true);
        expect(fillMissingDefaults(lobby, TEMPLATE)).toBe(0);
        for (const accessor of PROFILE_ACCESSORS) {
            expect(() => accessor.pure(lobby), accessor.name).not.toThrow();
            expect(accessor.pure(lobby), accessor.name).toBe(accessor.answer(lobby));
        }
    });

    it('with a card open, each accessor still repairs a wrong-typed field', () => {
        const stored = structuredClone(TEMPLATE);
        stored.imagegen.insertType = 'sideways';
        stored.imagegen.picturesVia = 3;
        stored.roster.route = 7;
        stored.logicEngine.enabled = 'yes';
        stored.sidePanel.order = null;
        expect(imagegenProfileOf(stored).insertType).toBe(imagegenProfileDefaults.imagegen.insertType);
        expect(imagegenProfileOf(stored).picturesVia).toBe('narrate');
        expect(rosterProfileOf(stored).route).toBe('harvest');
        expect(logicEngineProfileOf(stored).enabled).toBe(true);
        expect(sidePanelSettingsOf(stored).order).toEqual([]);
        expect(statBoxSectionOf({ statBox: { groups: [{}] } })).toEqual({ groups: [{}] });
    });
});
