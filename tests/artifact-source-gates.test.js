// tests/artifact-source-gates.test.js — the §7 generic content gates (W5).
// Each gate exists because something shipped broken first; every case here re-creates the incident
// shape in miniature and watches the gate name it.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { gateArtifactSource, depthZeroDeclarations, declaredFormatterNames, declaredActionNames, menuEngineTextToRead, menuEngineExportsFromScope } from '../src/shared/artifact-source-gates.js';
import { readMenuEngineExportsInProcess } from '../tools/menu-engine-exports-in-process.mjs';

// The gate never runs an engine: a caller reads a menu engine's exports first and passes them in. These
// tests read with the dev server's in-process reader, which drives the engine Worker's own load runtime.
const gate = (p) => {
    const text = menuEngineTextToRead(p);
    return gateArtifactSource(p, { menuEngineExports: text === null ? null : readMenuEngineExportsInProcess(text) });
};

const entry = (comment, content, over = {}) => ({ comment, type: 'constant', enabled: true, keys: [], content, ...over });
const pack = (over = {}) => ({ format: '1.0', packType: 'gamelogic', id: 'p', name: 'P', description: 'd', ...over });

describe('depthZeroDeclarations — the names that land in the one compile scope', () => {
    it('collects depth-0 let/const/var, including multi-declarator statements', () => {
        expect(depthZeroDeclarations('<% let a = 1, b = 2; const c = 3; %>')).toEqual(['a', 'b', 'c']);
    });
    it('a declaration inside braces is NOT depth-0', () => {
        expect(depthZeroDeclarations('<% if (x) { let inner = 1; } try { const t = 2; } catch (e) {} %>')).toEqual([]);
    });
    it('depth carries ACROSS scriptlets — a name declared inside a <% if { %> ... <% } %> pair is scoped', () => {
        expect(depthZeroDeclarations('<% if (x) { %>text<% let y = 1; } %>')).toEqual([]);
    });
    it('comments and strings cannot declare', () => {
        expect(depthZeroDeclarations('<% // let ghost = 1\n const s = "let fake = 2"; %>')).toEqual(['s']);
    });
    it('output tags (<%=) are expressions, not scriptlets', () => {
        expect(depthZeroDeclarations('<%= let broken %>')).toEqual([]);
    });
});

describe('G-A: every EJS entry compiles as one scope', () => {
    it('a clean entry passes', () => {
        const g = gate(pack({ entries: [entry('OK', '<% let a = 1; if (a) { %>yes<% } %>')] }));
        expect(g.errors).toEqual([]);
    });
    // The 2026-08-22 incident: a duplicate const inside ONE entry's try block — invisible to any
    // cross-entry scan, caught only by compiling what the file actually says.
    it('a duplicate declaration inside one entry fails, naming the entry', () => {
        const g = gate(pack({ entries: [entry('Window A', '<% try { const bandIdx = 1; const bandIdx = 2; } catch (e) {} %>')] }));
        expect(g.errors.some((e) => e.includes('"Window A"') && e.includes('already been declared'))).toBe(true);
    });
    it('a plain-prose entry is not compiled at all', () => {
        const g = gate(pack({ entries: [entry('Prose', 'no template here — just words with a { stray briefly')] }));
        expect(g.errors).toEqual([]);
    });
});

describe('G-B: constant entries share ONE render pass — depth-0 names must be unique there', () => {
    const colliding = [
        entry('Personality_HScene', '<% let _present = 1; %>'),
        entry('personality_archetypes', '<% let _present = 2; %>'),
    ];
    it('two constant entries declaring the same depth-0 name is an error naming BOTH', () => {
        const g = gate(pack({ entries: colliding }));
        expect(g.errors.some((e) => e.includes('_present') && e.includes('Personality_HScene') && e.includes('personality_archetypes'))).toBe(true);
    });
    it('the same name at depth 1 in one of them is legal', () => {
        const g = gate(pack({ entries: [colliding[0], entry('other', '<% if (x) { let _present = 2; } %>')] }));
        expect(g.errors).toEqual([]);
    });
    it('a SELECTIVE entry sharing the name is not in this bucket — its pass is consumer routing', () => {
        const g = gate(pack({ entries: [colliding[0], entry('pre-half', '<% let _present = 2; %>', { type: 'selective' })] }));
        expect(g.errors).toEqual([]);
    });
    it('a disabled constant entry never renders, so it cannot collide', () => {
        const g = gate(pack({ entries: [colliding[0], entry('parked', '<% let _present = 2; %>', { enabled: false })] }));
        expect(g.errors).toEqual([]);
    });
});

const ENGINE_OK = 'module.exports = { formatters: { money(stat, root) { return 1; }, unusedOne(s) { return 2; } }, actions: { equip(args, root) { return []; }, deleteItem(args, root) { return []; } } };\n';
const menuPack = (layout, engine = ENGINE_OK) => pack({ packType: 'statusmenu', layout, engine, targetsPackId: 't' });
const cell = (name) => ({ tabs: [{ blocks: [{ cards: [{ type: 'StatRow', formatters: { text: name } }] }] }] });

describe('G-C: every formatter the layout names is exported by the engine BESIDE it (§3.5)', () => {
    it('a named-and-exported formatter passes (the unused export warns)', () => {
        const g = gate(menuPack(cell('money')));
        expect(g.errors).toEqual([]);
        expect(g.warnings.some((w) => w.includes('unusedOne'))).toBe(true);
    });
    it('a layout naming a formatter the engine does not export is an ERROR naming both halves', () => {
        const g = gate(menuPack(cell('salary')));
        expect(g.errors.some((e) => e.includes('"salary"') && e.includes('does not export'))).toBe(true);
    });
    it('an engine that throws at load is an error — the Worker will hit the same throw', () => {
        const g = gate(menuPack(cell('money'), 'throw new Error("boom");'));
        expect(g.errors.some((e) => e.includes('failed to load') && e.includes('boom'))).toBe(true);
    });
    it('no engine at all is silent — a menu legally runs before its engine exists (§3.4)', () => {
        const g = gate(pack({ packType: 'statusmenu', layout: cell('money'), targetsPackId: 't' }));
        expect(g.errors).toEqual([]);
    });
    it('a GAMELOGIC engine is never executed here — only compiled', () => {
        // This engine COMPILES but would throw if run; a gamelogic pack must pass untouched.
        const g = gate(pack({ engine: '// v1.0\nconst ENGINE_NAME = \'probe\';\nthrow new Error("must not run");' }));
        expect(g.errors).toEqual([]);
    });
    it('declaredFormatterNames walks shape-blind — a formatters map anywhere counts', () => {
        const names = declaredFormatterNames({ deep: { nest: [{ formatters: { image: 'pic' } }] } });
        expect([...names.keys()]).toEqual(['pic']);
    });
    it('the in-process reader reads the real starter shape', () => {
        const r = readMenuEngineExportsInProcess(ENGINE_OK);
        expect(r.ok).toBe(true);
        expect(r.formatters).toEqual(['money', 'unusedOne']);
        expect(r.actions).toEqual(['equip', 'deleteItem']);
    });
});

describe('G-C, the write half: every action a layout names is exported by the engine beside it (B5)', () => {
    const button = (action) => ({ tabs: [{ blocks: [{ cards: [{ type: 'ActionButton', title: 'Go', action, args: { amount: 1 } }] }] }] });
    it('a named-and-exported action passes', () => {
        const g = gate(menuPack(button('equip')));
        expect(g.errors).toEqual([]);
    });
    it('a layout naming an action the engine does not export is an ERROR naming both halves and the site', () => {
        const g = gate(menuPack(button('teleport')));
        expect(g.errors.some((e) => e.includes('action "teleport"') && e.includes('tabs.0.blocks.0.cards.0') && e.includes('refused by name'))).toBe(true);
    });
    it('an exported action no cell names is NOT warned — the renderer\'s own row buttons invoke those', () => {
        const g = gate(menuPack(button('equip')));
        expect(g.warnings.some((w) => w.includes('deleteItem'))).toBe(false);
    });
    it('declaredActionNames walks shape-blind and skips blank names', () => {
        const names = declaredActionNames({ deep: [{ action: ' rest ' }, { action: '' }, { action: 7 }] });
        expect([...names.keys()]).toEqual(['rest']);
    });
});

describe('G-D: the engine text compiles', () => {
    it('a syntax-broken engine is one error', () => {
        const g = gate(pack({ engine: '// v1.0\nconst = broken' }));
        expect(g.errors.length).toBe(1);
        expect(g.errors[0]).toContain('does not compile');
    });
    it('a syntax-broken STATUSMENU engine reports the compile failure ONCE, not once per gate', () => {
        const g = gate(menuPack(cell('money'), 'const = broken'));
        expect(g.errors.length).toBe(1);
        expect(g.errors[0]).toContain('does not compile');
    });
});

describe('G-E: ENGINE_NAME declaration nudge', () => {
    it('a gamelogic engine that declares no name warns', () => {
        const g = gate(pack({ engine: '// v1.0\nmodule.exports = {};' }));
        expect(g.warnings.some((w) => w.includes('ENGINE_NAME'))).toBe(true);
    });
    it('a COMMENT naming it is not a DECLARATION — only the const silences this', () => {
        const g = gate(pack({ engine: '// v1.0\n// ENGINE_NAME is School\nmodule.exports = {};' }));
        expect(g.warnings.some((w) => w.includes('ENGINE_NAME'))).toBe(true);
    });
    it('with the declaration, silent', () => {
        const g = gate(pack({ engine: '// v1.0\nconst ENGINE_NAME = \'School\';\nmodule.exports = { ENGINE_NAME };' }));
        expect(g.warnings).toEqual([]);
    });
    it('a StatusMenu engine is exempt — nothing consumes a menu engine name', () => {
        const g = gate(menuPack(cell('money')));
        expect(g.warnings.some((w) => w.includes('ENGINE_NAME'))).toBe(false);
    });
    // A PLUGIN engine's name is parsed by nobody: parseEngineName's one runtime call site reads the
    // GAME text, and `engine.name` in a resolver's ctx is the game's. Nudging a plugin author to add
    // a line nothing reads is the exact fault this gate exists to catch, pointed the wrong way —
    // live 2026-08-29, every plugin engine in the School workspace drew it.
    it('a PLUGIN engine is exempt too — its own name is read by nobody', () => {
        const g = gate(pack({ packType: 'plugin', engine: '// v0.1\nmodule.exports = { resolveRelay: () => ({}) };' }));
        expect(g.warnings.some((w) => w.includes('ENGINE_NAME'))).toBe(false);
    });
});

describe('the aggregate is safe on garbage', () => {
    it('null pack, no entries, no engine — empty result, no throw', () => {
        expect(gate(null)).toEqual({ errors: [], warnings: [] });
        expect(gate(pack())).toEqual({ errors: [], warnings: [] });
    });
});

// ── G-F: the layout's scope vs the declared id ──────────────────────────────────────────────────
// THE INCIDENT (live 2026-09-19). School's own StatusMenu shipped a layout scoped `statusmenu` while
// pack.json declared `artifickoi`: 141 CSS rules matched nothing and 7 locale keys never reached their
// base names, so the menu rendered UNSTYLED with "undefined" labels. It assembled clean, installed
// clean and drew — which is the exact class this file gates. The authoring tool cannot catch it (a
// browser app never sees the workspace), so the assembler is the only place the two halves meet.
describe('G-F: a layout scoped to a pack id that is not this pack\'s', () => {
    const menu = (over = {}) => pack({ packType: 'statusmenu', id: 'artifickoi', ...over });
    const layout = (scope, over = {}) => ({
        kind: 'tabbed-grid',
        globalCss: '[data-pack="' + scope + '"] .status-card { color: red; }\n[data-pack="' + scope + '"] .row { gap: 4px; }',
        staticLocale: { ['pack.' + scope + '.empty_quest']: 'No active quests' },
        ...over,
    });

    it('THE REGRESSION GUARD: a foreign scope is an ERROR naming both ids', () => {
        const g = gate(menu({ layout: layout('statusmenu') }));
        expect(g.errors.length).toBe(2);                               // the CSS half and the locale half
        expect(g.errors.join(' ')).toContain('"statusmenu"');
        expect(g.errors.join(' ')).toContain('"artifickoi"');
    });

    it('names the CSS half separately, because it is the half that fails SILENTLY at render', () => {
        const g = gate(menu({ layout: layout('statusmenu', { staticLocale: {} }) }));
        expect(g.errors.length).toBe(1);
        expect(g.errors[0]).toContain('ships unstyled');
    });

    it('names the locale half separately, with the symptom the author will actually see', () => {
        const g = gate(menu({ layout: layout('statusmenu', { globalCss: '' }) }));
        expect(g.errors.length).toBe(1);
        expect(g.errors[0]).toContain('"undefined"');
    });

    it('the matching id is silent — this must not fire on every correct menu', () => {
        expect(gate(menu({ layout: layout('artifickoi') })).errors).toEqual([]);
    });

    it('reports each foreign scope ONCE, however many rules carry it', () => {
        const css = new Array(50).fill('[data-pack="other"] .x { color: red; }').join('\n');
        const g = gate(menu({ layout: layout('artifickoi', { globalCss: css }) }));
        expect(g.errors.length).toBe(1);
        expect(g.errors[0].match(/"other"/g).length).toBe(1);
    });

    it('a locale key that is not pack-scoped is none of this gate\'s business', () => {
        const g = gate(menu({ layout: layout('artifickoi', { staticLocale: { header_core: 'Core Status' } }) }));
        expect(g.errors).toEqual([]);
    });

    it('no id ⇒ silent: a missing id is the pack rules\' finding, and one cause earns one line', () => {
        const g = gate(menu({ id: '', layout: layout('statusmenu') }));
        expect(g.errors).toEqual([]);
    });

    it('an artifact with no layout is not a menu and is never asked', () => {
        expect(gate(pack({ engine: '// v1.0\nconst ENGINE_NAME = \'X\';\nmodule.exports = { ENGINE_NAME };' })).errors).toEqual([]);
    });
});

// A menu engine arrives from a picked ZIP or a shared card, so the gate is handed its exports and never
// runs it. These pin that contract and the readers on each side of it.
describe('G-C reads the menu engine OUTSIDE the gate — never on the page', () => {
    it('a menu that ships an engine, gated without its exports, THROWS — a skipped read is never a pass', () => {
        expect(() => gateArtifactSource(menuPack(cell('money')))).toThrow(/must read its exports first/);
    });

    it('a menu without an engine, or a pack without a layout, needs no read', () => {
        expect(menuEngineTextToRead(pack({ packType: 'statusmenu', layout: cell('money'), targetsPackId: 't' }))).toBe(null);
        expect(menuEngineTextToRead(pack({ engine: 'module.exports = {};' }))).toBe(null);
        expect(menuEngineTextToRead(menuPack(cell('money')))).toBe(ENGINE_OK);
    });

    it('the converter counts only FUNCTION exports one level under formatters/actions — what the Worker can call', () => {
        const r = readMenuEngineExportsInProcess('module.exports = { formatters: { money: "not a function", ok() {} }, actions: { go() {} }, helper() {} };');
        expect(r).toEqual({ ok: true, error: '', formatters: ['ok'], actions: ['go'] });
    });

    it('a load error in the scope report is a failed read, carrying the message', () => {
        expect(menuEngineExportsFromScope({ error: 'boom', nestedExports: ['formatters.x'] })).toEqual({ ok: false, error: 'boom', formatters: [], actions: [] });
    });

    // The pins: shipped code holds no in-page executor, and every page caller hands the Worker reader in.
    const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
    it('the gate module runs no text — it compiles (G-D) and never calls what it compiled', () => {
        const source = read('src/shared/artifact-source-gates.js');
        expect(source).not.toMatch(/new Function\([^)]*\)\s*\(/);
        expect(source).not.toMatch(/readMenuEngineExports\b(?!InWorker|InProcess)/);
    });

    it('nothing under src/ imports the in-process reader from tools/', () => {
        const files = readdirSync(new URL('../src', import.meta.url), { recursive: true }).filter((f) => String(f).endsWith('.js'));
        const offenders = files.filter((f) => /from\s+['"][^'"]*tools\//.test(read('src/' + String(f).split('\\').join('/'))));
        expect(offenders).toEqual([]);
    });

    it('the page callers read with the engine frame Worker', () => {
        expect(read('src/features/gamelogic-pack/artifact-tabs-ui.js')).toContain('buildWorkspaceArtifacts(files, { readMenuEngine: readMenuEngineExportsInWorker })');
        expect(read('src/features/statusmenu-pack/statusmenu-pack-activation.js')).toContain('menuEngineExports = await readMenuEngineExportsInWorker(menuEngineText)');
    });

    it('the throwaway Worker is made by the engine frame, never touches the running engine, and always ends', () => {
        const host = read('src/features/logic-engine/engine-worker-host.js');
        const reader = host.slice(host.indexOf('export async function readEngineScopeInThrowawayWorker'));
        expect(reader).toContain('const frameWindow = await ensureEngineFrame();');
        expect(reader).toContain('makeFrameWorker(frameWindow, imports)');
        expect(reader).not.toMatch(/terminateEngineWorker|current\b/);
        expect(reader).toMatch(/finally \{\s*worker\.terminate\(\);/);
    });
});
