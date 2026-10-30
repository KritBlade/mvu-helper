// tests/artifact-skeletons.test.js — the blank-artifact cold start (workflow plan W8, §2.7).
//
// THE GUARANTEE UNDER TEST: every skeleton is fed through assembleArtifactSource + validatePack +
// gateArtifactSource — the same pipeline the dev loop and the import run — so a starter that stops
// matching the format fails CI in this repo instead of failing a stranger on their first day. The
// engines are additionally EXECUTED, because "compiles" is not "the Worker's call works".

import { describe, it, expect } from 'vitest';
import { buildBlankArtifactMembers, artifactRootMembers, deriveArtifactId, BLANK_ARTIFACT_TYPES } from '../src/shared/artifact-skeletons.js';
import { assembleArtifactSource } from '../src/shared/artifact-source-assembler.js';
import { gateArtifactSource, menuEngineTextToRead } from '../src/shared/artifact-source-gates.js';
import { readMenuEngineExportsInProcess } from '../tools/menu-engine-exports-in-process.mjs';

// The gates are handed a menu engine's exports, read outside them (the dev server's in-process reader).
const gate = (p) => {
    const text = menuEngineTextToRead(p);
    return gateArtifactSource(p, { menuEngineExports: text === null ? null : readMenuEngineExportsInProcess(text) });
};
import { validatePack, declaredCallBindings } from '../src/features/gamelogic-pack/gamelogic-pack-core.js';
import { PLACEHOLDER_SHELL_REGEX } from '../src/shared/placeholder-menu-shell.js';
import { isTavernHelperFrontendText } from '../src/shared/rendered-region.js';
import { buildStoredZip, crc32 } from '../src/shared/stored-zip.js';
import { EVENT_GUIDE_CODE_START, EVENT_GUIDE_CODE_END } from '../src/shared/artifact-skeletons.js';
import { executeEngineText, declaredIdentity, readEventContract } from '../src/features/logic-engine/logic-engine-core.js';
import { unallowedWritePaths, undeclaredScopeRows } from '../src/features/event-pack/event-pack-core.js';
import { schoolv4Dir, haveSchoolv4 } from './schoolv4-artifact.mjs';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const IDENTITY = { name: 'My Game', description: 'A blank artifact', builtWith: 'mvu-helper 0.0.0-test' };
const build = (packType, over = {}) =>
    buildBlankArtifactMembers({ packType, id: 'my-game', ...IDENTITY, ...over });
const assembleOf = (built) => assembleArtifactSource(artifactRootMembers(built.members, built.folder));

// Execute an engine text the way the Worker shim does: module/exports as parameters.
function executeEngine(text) {
    const box = { exports: {} };
    new Function('module', 'exports', text)(box, box.exports);
    return box.exports;
}
const memberText = (built, tail) => built.members.find((m) => m.path.endsWith(tail))?.text;

describe('every skeleton survives the one pipeline — assembler, validator, gates', () => {
    for (const { packType } of BLANK_ARTIFACT_TYPES) {
        it(packType + ': assembles with zero errors/warnings, validates ok, gates green', () => {
            const built = build(packType);
            expect(built.errors).toEqual([]);
            const a = assembleOf(built);
            expect(a.errors).toEqual([]);
            expect(a.warnings).toEqual([]);
            const v = validatePack(a.pack);
            expect(v.errors).toEqual([]);
            expect(v.ok).toBe(true);
            expect(v.warnings).toEqual([]);
            const g = gate(a.pack);
            expect(g.errors).toEqual([]);
            expect(g.warnings).toEqual([]);
        });
        it(packType + ': identity fields land derived and stamped', () => {
            const a = assembleOf(build(packType));
            expect(a.pack.packType).toBe(packType);
            expect(a.pack.format).toBe('1.0');
            expect(a.pack.version).toBe('0.1.0');
            expect(a.pack.builtWith).toBe(IDENTITY.builtWith);
        });
    }
    it('the folders arrive named — plugin gets plugin-<id> (§2.7)', () => {
        expect(build('gamelogic').folder).toBe('gamelogic');
        expect(build('statusmenu').folder).toBe('statusmenu');
        expect(build('plugin').folder).toBe('plugin-my-game');
    });
});

describe('the engines are minimal but WORKING — executed, not just compiled', () => {
    it('gamelogic: resolveTurn answers the turn runner\'s contract', () => {
        const api = executeEngine(memberText(build('gamelogic'), 'engine/gameLogic.cjs'));
        const statData = { a: 1 };
        const r = api.resolveTurn(statData, { mid: 1, swipe: 0, dice: [], ops: [] });
        expect(r.statData).toBe(statData);
        expect(r.applied).toBe(false);
        expect(r.log).toEqual([]);
    });
    // The ASSEMBLED engine — both files joined in engineOrder — because that join is what the Worker
    // runs; statusMenuLogic.cjs alone reads a LAYOUT_FORMATTERS it never declares.
    it('statusmenu: the joined engine exports empty formatters and actions maps', () => {
        const api = executeEngine(assembleOf(build('statusmenu')).pack.engine);
        expect(api.ENGINE_VERSION).toBe('v0.1.0');
        expect(api.formatters).toEqual({});
        expect(api.actions).toEqual({});
    });
    it('plugin: resolveRelay returns an empty patch set', () => {
        const api = executeEngine(memberText(build('plugin'), 'engine/relay-resolver.cjs'));
        const r = api.resolveRelay({ ownState: {}, ops: [], ownRoot: 'GameLogicPlugin.x', ownPointer: '/GameLogicPlugin/x', mid: 1, swipe: 0 });
        expect(r.patches).toEqual([]);
    });
});

describe('the statusmenu skeleton carries the pack-host shell (§2.7 ▲ — a shell-less cold start renders nothing)', () => {
    it('regex/StatusMenu.json is the vendored shell VERBATIM, builder byte format', () => {
        expect(memberText(build('statusmenu'), 'regex/StatusMenu.json'))
            .toBe(JSON.stringify(PLACEHOLDER_SHELL_REGEX, null, 2) + '\n');
    });
    it('the vendored shell is the generic one: StatusMenu identity, placeholder trigger, no School leak', () => {
        expect(PLACEHOLDER_SHELL_REGEX.script_name).toBe('StatusMenu');
        expect(PLACEHOLDER_SHELL_REGEX.find_regex).toBe('<StatusPlaceHolderImpl/>');
        // SMALL on purpose, and the assertion is the point: this used to be a 201KB vendored copy of
        // the builder's real shell, and the whole reason it is not any more is that mvu-helper must
        // not carry another repo's build output. A regression to a big blob is a regression to that.
        expect(PLACEHOLDER_SHELL_REGEX.replace_string.length).toBeLessThan(8000);
        // It must SAY what it is and where the real one comes from, or it reads as a broken menu.
        expect(PLACEHOLDER_SHELL_REGEX.replace_string).toContain('MVU Status Menu Builder');
        expect(PLACEHOLDER_SHELL_REGEX.replace_string).toContain('No menu built yet');
        // NO fence and NO document (containment M2): a fenced <html> is what TavernHelper renders into
        // an unsandboxed iframe, and no row this extension writes may carry one. The notice is plain
        // HTML inside the rendered-region container; SillyTavern renders it itself.
        expect(PLACEHOLDER_SHELL_REGEX.replace_string).not.toContain(String.fromCharCode(96).repeat(3));
        expect(isTavernHelperFrontendText(PLACEHOLDER_SHELL_REGEX.replace_string)).toBe(false);
        expect(PLACEHOLDER_SHELL_REGEX.replace_string).not.toContain('<script');
        // No consumer vocabulary, same as before (L1).
        expect(PLACEHOLDER_SHELL_REGEX.replace_string).not.toContain('Mainchar');
        expect(PLACEHOLDER_SHELL_REGEX.replace_string).not.toContain('Mitsuki');
    });
});

// The layout MVU Status Menu Builder exports (2.7.0 on): the builder owns layoutFormatters.cjs and
// replaces it on every layout export, the developer owns statusMenuLogic.cjs. A skeleton laid out any
// other way leaves the first refresh zip naming a file its engineOrder refuses.
describe('the statusmenu engine is two files, one owner each (devdoc/statusmenu-pack-format.md §3.1)', () => {
    const built = build('statusmenu');
    const generated = memberText(built, 'engine/layoutFormatters.cjs');
    const developer = memberText(built, 'engine/statusMenuLogic.cjs');
    const joinWith = (hand) => generated + developer.replace('const HAND_FORMATTERS = {\n};', 'const HAND_FORMATTERS = {\n' + hand + '\n};');

    it('engineOrder loads the generated file first — the engine reads LAYOUT_FORMATTERS', () => {
        expect(JSON.parse(memberText(built, 'pack.json')).engineOrder).toEqual(['layoutFormatters.cjs', 'statusMenuLogic.cjs']);
    });
    it('layoutFormatters.cjs declares ONE top-level name and no ENGINE_VERSION', () => {
        expect([...generated.matchAll(/^(?:const|let|var|function|class)\s+(\w+)/gm)].map((m) => m[1])).toEqual(['LAYOUT_FORMATTERS']);
        expect(generated).not.toContain('ENGINE_VERSION');
    });
    it('statusMenuLogic.cjs alone fails, naming LAYOUT_FORMATTERS — it is never loaded without the generated file', () => {
        expect(() => executeEngine(developer)).toThrow(/LAYOUT_FORMATTERS/);
    });
    it('a formatter written by hand is exported beside the layout\'s', () => {
        const api = executeEngine(joinWith('    handMade(stat) { return 1; },'));
        expect(Object.keys(api.formatters)).toEqual(['handMade']);
    });
    it('MUTATION target — a hand formatter the layout also computes is refused at load, naming both files', () => {
        const withLayout = joinWith('    shared(stat) { return 1; },').replace('const LAYOUT_FORMATTERS = {};', 'const LAYOUT_FORMATTERS = { shared() { return 0; } };');
        expect(() => executeEngine(withLayout)).toThrow(/statusMenuLogic\.cjs AND computed by the layout \(layoutFormatters\.cjs\)/);
    });
    it('MUTATION — engineOrder reversed ⇒ the gates report the engine failed to load', () => {
        const reversed = {
            ...built,
            members: built.members.map((m) => (m.path.endsWith('pack.json')
                ? { ...m, text: JSON.stringify({ ...JSON.parse(m.text), engineOrder: ['statusMenuLogic.cjs', 'layoutFormatters.cjs'] }) }
                : m)),
        };
        const a = assembleOf(reversed);
        expect(a.errors).toEqual([]);
        expect(gate(a.pack).errors.some((e) => e.includes('failed to load'))).toBe(true);
    });
    it('layout/README.txt teaches the refresh zip, and that it carries both builder-owned files', () => {
        const text = memberText(built, 'layout/README.txt');
        expect(text).toContain('Refresh layout .zip');
        expect(text).toContain('engine/layoutFormatters.cjs');
        expect(text).toContain('never touches engine/statusMenuLogic.cjs');
    });
});

describe('the plugin skeleton routes nothing until its windows are written', () => {
    it('MUTATION TARGET — the PRE and POST scaffolds carry no call token, so a fresh install routes nothing and asks for no call', () => {
        const built = build('plugin');
        const pre = JSON.parse(memberText(built, 'pre-window.json'));
        const record = JSON.parse(memberText(built, 'record-window.json'));
        expect(pre.comment).not.toContain('{PRE_CALL}');
        expect(record.comment).not.toContain('{POST_CALL}');
        // Routing reads comments AND the call-binding declaration reads content too: neither may carry a token.
        expect(declaredCallBindings(assembleOf(built).pack)).toEqual({ pre: false, post: false });
    });
    it('MUTATION TARGET — each routed scaffold is disabled and selective, so switching it on never puts it in the narrator\'s prompt', () => {
        const built = build('plugin');
        for (const stem of ['pre-window', 'record-window']) {
            const sidecar = JSON.parse(memberText(built, stem + '.json'));
            expect(sidecar.enabled).toBe(false);
            expect(sidecar.type).toBe('selective');
            expect(sidecar.keys).toEqual([]);
        }
    });
    it('each routed scaffold says how to route it and to keep it disabled', () => {
        const built = build('plugin');
        expect(memberText(built, 'pre-window.txt')).toContain('PRE_CALL in\ncurly braces');
        expect(memberText(built, 'record-window.txt')).toContain('POST_CALL in\ncurly braces');
        for (const stem of ['pre-window', 'record-window']) {
            expect(memberText(built, stem + '.txt')).toContain('Keep the entry disabled');
            expect(memberText(built, stem + '.txt')).not.toContain('"enabled": true');
        }
        expect(memberText(built, 'pre-window.txt')).toContain('APPEND, NEVER OPEN');
    });
    it('the narrate scaffold is a narrator entry: disabled until written, constant, and switched on by "enabled"', () => {
        const built = build('plugin');
        const narrate = JSON.parse(memberText(built, 'narrate-window.json'));
        expect(narrate.enabled).toBe(false);
        expect(narrate.type).toBe('constant');
        expect(memberText(built, 'narrate-window.txt')).toContain('"enabled": true');
        expect(memberText(built, 'narrate-window.txt')).toContain('{OWN_ROOT}');
        expect(memberText(built, 'record-window.txt')).toContain('{OWN_ROOT}');
    });
    it('the sidecar type is the STRING spelling — the boolean-constant trap stays taught by example', () => {
        expect(JSON.parse(memberText(build('gamelogic'), 'example-window.json')).type).toBe('constant');
    });
});

describe('the statusmenu placeholders carry their warnings (user 2026-08-31: the builder is the authority)', () => {
    const built = build('statusmenu');
    it('layout/README.txt says the layout is an example and the builder authors the real one', () => {
        const text = memberText(built, 'layout/README.txt');
        expect(text).toContain('EXAMPLE');
        expect(text).toContain('MVU Status Menu Builder');
    });
    // The shipped StatusMenu.json is a stand-in, not the builder's generated shell; a README calling it
    // generated would send a developer looking for a menu that is not there.
    it('regex/README.txt says the shell is a PLACEHOLDER and names what replaces it', () => {
        const text = memberText(built, 'regex/README.txt');
        expect(text).toContain('PLACEHOLDER');
        expect(text).toContain('REPLACES this one');
        expect(text).toContain('Never hand-edit a');
        expect(text).not.toContain('GENERATED pack-host shell');
    });
    it('BOTH name the builder — it is the authority for either file, and a README that omits it sends the developer nowhere', () => {
        for (const path of ['layout/README.txt', 'regex/README.txt']) {
            expect(memberText(built, path)).toContain('MVU Status Menu Builder');
        }
    });
    it('the READMEs ride the archive but never the pack — the assembler ignores them (§28.1)', () => {
        const a = assembleOf(built);
        expect(a.errors).toEqual([]);
        expect(JSON.stringify(a.pack)).not.toContain('README');
    });
});

describe('the gamelogic skeleton demonstrates every section §3 lets it carry', () => {
    const built = build('gamelogic');
    const pack = assembleOf(built).pack;
    it('engine, entries, regex and schema all assemble', () => {
        for (const section of ['engine', 'entries', 'regex', 'schema']) expect(pack[section]).toBeDefined();
    });
    it('the sample regex passes rule 10 and edits the SCREEN, never the prompt', () => {
        expect(pack.regex).toHaveLength(1);
        const [r] = pack.regex;
        expect(r.script_name).toBe('HideFarFloor');       // identity — never the filename
        expect(r.find_regex).toBe('/.*/s');               // /pattern/flags, s so . spans newlines
        expect(r.destination.prompt).toBe(false);         // display-only ⇒ no rule 10 prompt warning
        expect(r.min_depth).toBe(10);
    });
    it('the sample schema REGISTERS — the three things a trimmed copy loses first', () => {
        expect(pack.schema).toContain('registerMvuSchema(StatDataSchema)');   // the call, not just the import
        expect(pack.schema).toContain('const strEmpty =');                    // the base atoms the helpers need
        expect(pack.schema).toContain('const StatDataSchema =');              // a top level to register
    });
    it('every identifier the schema USES is one it DEFINES (a ReferenceError at import, otherwise)', () => {
        const defined = new Set([...pack.schema.matchAll(/^const (\w+)/gm)].map((m) => m[1]));
        for (const name of ['strEmpty', 'num0', 'boolFalse', 'labeledStr', 'labeledNum', 'labeledBool']) {
            expect(pack.schema).toContain(name);
            expect(defined.has(name)).toBe(true);
        }
    });
    it('the platform roots ship declared OPEN — rule 7 refuses a closed one', () => {
        expect(pack.schema).toContain('GameLogicPlugin: z.record(z.string(), z.any())');
        expect(pack.schema).toContain('$mvuhelper: z.record(z.string(), z.any())');
        expect(validatePack(pack).ok).toBe(true);
    });
    it('MUTATION — closing $mvuhelper fails rule 7, naming whose parts it would strip', () => {
        const closed = { ...pack, schema: pack.schema.replace('$mvuhelper: z.record(z.string(), z.any()).prefault({})', '$mvuhelper: z.object({}).prefault({})') };
        const v = validatePack(closed);
        expect(v.ok).toBe(false);
        const said = v.errors.filter((e) => e.startsWith('rule 7:'));
        expect(said).toHaveLength(1);
        expect(said[0]).toMatch(/"\$mvuhelper" with a CLOSED shape/);
        expect(said[0]).toMatch(/mvu-helper names its own parts there/);
    });
    it('MUTATION — a z.object root without $mvuhelper declared is refused: the lock would take mvu-helper state', () => {
        const locked = {
            ...pack,
            schema: pack.schema
                .replace('.looseObject({', '.object({')
                .replace('    $mvuhelper: z.record(z.string(), z.any()).prefault({}),', ''),
        };
        expect(locked.schema).not.toContain('$mvuhelper:');
        const v = validatePack(locked);
        expect(v.ok).toBe(false);
        expect(v.errors.filter((e) => e.startsWith('rule 7b:'))).toHaveLength(1);
    });
    it('the ROOT ships declared loose — rule 7b refuses a closed one, and a skeleton must not mint that bug', () => {
        expect(pack.schema).toContain('.looseObject({');
        // the ROOT's own form. A nested z.object (castMemberSchema) is correct and stays, so the
        // assertion has to name the root's own declaration rather than the form appearing anywhere.
        expect(/const StatDataSchema = z\s*\.looseObject\(\{/.test(pack.schema)).toBe(true);
        expect(validatePack(pack).ok).toBe(true);
    });
    // Closing the root ON PURPOSE is a game card's call — freezing the top level so nobody can invent
    // stat_data.<key> at will. A game pack that also declares every platform root open is therefore WARNED,
    // not refused: what it would delete is protected as far as this validator can see, and the cost it
    // still carries is the author's to accept.
    it('MUTATION — a z.object root on a pack that declares the platform roots open WARNS, naming what a lock still costs', () => {
        const locked = { ...pack, schema: pack.schema.replace('.looseObject({', '.object({') };
        const v = validatePack(locked);
        expect(v.ok).toBe(true);
        expect(v.errors.some((e) => e.startsWith('rule 7b:'))).toBe(false);
        const said = v.warnings.filter((w) => w.startsWith('rule 7b:'));
        expect(said).toHaveLength(1);
        expect(said[0]).toMatch(/Every OTHER root that arrives later is lost/);
        expect(said[0]).toMatch(/silently/);           // and HOW it is lost, which differs by form
    });
    it('MUTATION — a z.object root with GameLogicPlugin closed TOO is refused, naming the record shape to write', () => {
        const both = {
            ...pack,
            schema: pack.schema
                .replace('.looseObject({', '.object({')
                .replace('GameLogicPlugin: z.record(z.string(), z.any()).prefault({})', 'GameLogicPlugin: z.object({}).prefault({})'),
        };
        const v = validatePack(both);
        expect(v.ok).toBe(false);
        const said = v.errors.filter((e) => e.startsWith('rule 7b:'));
        expect(said).toHaveLength(1);
        expect(said[0]).toMatch(/z\.record\(z\.string\(\), z\.any\(\)\)/);
    });
    it('MUTATION — a PLUGIN closing the root is refused either way: it never owns the root', () => {
        const pluginPack = assembleOf(build('plugin')).pack;
        pluginPack.schema = String(pluginPack.schema).replace('.looseObject({', '.object({');
        const v = validatePack(pluginPack);
        expect(v.ok).toBe(false);
        const said = v.errors.filter((e) => e.startsWith('rule 7b:'));
        expect(said).toHaveLength(1);
        expect(said[0]).toMatch(/strips the whole game/);
    });
    it('MUTATION — closing that root fails rule 7 through this very pipeline', () => {
        const closed = { ...pack, schema: pack.schema.replace('GameLogicPlugin: z.record(z.string(), z.any()).prefault({})', 'GameLogicPlugin: z.object({}).prefault({})') };
        const v = validatePack(closed);
        expect(v.ok).toBe(false);
        expect(v.errors.some((e) => e.includes('rule 7'))).toBe(true);
    });
    it('GENRE-BLIND (L1) — no consumer vocabulary in any member', () => {
        const all = built.members.map((m) => m.text).join('\n');
        for (const word of ['Classmate', 'Mainchar', 'Mitsuki', 'Hagaruro', 'Cup_Size']) {
            expect(all).not.toContain(word);
        }
    });
});

// The gamelogic skeleton does not ship eventpack.cjs (mvu-helper carries no other repo's file); its
// engine/README.txt says where the library comes from and shows the whole wiring.
describe('the gamelogic skeleton\'s event guide (engine/README.txt)', () => {
    const built = build('gamelogic');
    const guide = memberText(built, 'engine/README.txt');
    it('rides the archive but never the pack — the engine stays gameLogic.cjs alone', () => {
        const a = assembleOf(built);
        expect(a.errors).toEqual([]);
        expect(a.pack.engine).not.toContain('EVENT PACKS');
        expect(JSON.parse(memberText(built, 'pack.json')).engineOrder).toEqual(['gameLogic.cjs']);
    });
    it('names where eventpack.cjs comes from and the engineOrder that loads it first', () => {
        expect(guide).toContain('maker-app/GameLogic/_engine/eventpack.cjs');
        expect(guide).toContain('"engineOrder": ["eventpack.cjs", "gameLogic.cjs"]');
    });
    it('its schema lines use only atoms the sample schema defines', () => {
        const schema = memberText(built, 'schema/statdata_schema.js');
        expect(guide).toContain('armed: labeledStr');
        expect(schema).toContain('const labeledStr =');
    });
});

// The guide's gameLogic.cjs, RUN against the real library through the evaluator mvu-helper's Worker
// uses. Skips only when the game repo is not checked out; a checkout without the library FAILS.
describe.skipIf(!haveSchoolv4())('the guide\'s gameLogic.cjs runs events against the real eventpack.cjs', () => {
    const LIBRARY = path.join(schoolv4Dir(), '..', '_engine', 'eventpack.cjs');
    it('the library is where the guide says', () => {
        expect(existsSync(LIBRARY), 'missing: ' + LIBRARY).toBe(true);
    });
    const guide = memberText(build('gamelogic'), 'engine/README.txt');
    const code = guide.slice(guide.indexOf(EVENT_GUIDE_CODE_START) + EVENT_GUIDE_CODE_START.length, guide.indexOf(EVENT_GUIDE_CODE_END));
    const library = existsSync(LIBRARY) ? readFileSync(LIBRARY, 'utf8') : '';
    const load = () => executeEngineText(library + '\n' + code, {});          // engineOrder: eventpack.cjs, gameLogic.cjs
    const row = (over = {}) => ({ cat: 'TRG', series: '', prereq: '', when: 'World.Hour>=10', fx: { summary: 'A first event.' }, ...over });
    const state = (triggers) => ({
        World: { Hour: [12, 'Hour'] },
        EventPack: { triggers, armed: ['', 'Armed event'] },
        Intent: { eventFire: ['', 'Event fired'] },
    });

    it('exports the adapter mvu-helper reads, and the library\'s own format level', () => {
        const api = load();
        const lib = executeEngineText(library, {});
        expect(api.EVENT_PACK_FORMAT).toBe(lib.FORMAT);
        const contract = readEventContract(declaredIdentity(api));
        expect(contract.paths.ok).toBe(true);
        expect(contract.writes.ok).toBe(true);
        expect(contract.scopes.ok).toBe(true);
        expect(contract.format).toBe(lib.FORMAT);
    });
    it('arms an eligible event as a [value, label] pair — what the builder\'s [0] gate reads', () => {
        const sd = state({ my_first: row() });
        const r = load().resolveTurn(sd, {});
        expect(r.applied).toBe(true);
        expect(sd.EventPack.armed).toEqual(['@my_first', 'Armed event']);
        expect(r.log).toContain('EVENT ARMED -> @my_first');
    });
    it('arms nothing while the condition does not hold', () => {
        const sd = state({ my_first: row() });
        sd.World.Hour = [8, 'Hour'];
        load().resolveTurn(sd, {});
        expect(sd.EventPack.armed[0]).toBe('');
    });
    // A series: the second beat becomes eligible the moment the first is done. It must still wait for the
    // NEXT reply, which is what "not in the reply one fired" in the guide's resolveTurn promises.
    it('fires on the narrator\'s report: records it done, clears the report, and the next beat waits a reply', () => {
        const api = load();
        const sd = state({ my_first: row(), my_second: row({ prereq: 'flag:my_first' }) });
        api.resolveTurn(sd, {});
        expect(sd.EventPack.armed[0]).toBe('@my_first');
        sd.Intent.eventFire[0] = 'my_first';
        const r = api.resolveTurn(sd, {});
        expect(sd.EventPack.fired.my_first.state).toBe('done');
        expect(sd.Intent.eventFire).toEqual(['', 'Event fired']);
        expect(sd.EventPack.armed[0]).toBe('');
        expect(r.applied).toBe(true);
        api.resolveTurn(sd, {});
        expect(sd.EventPack.armed[0]).toBe('@my_second');
    });
    it('a row\'s writes are reported at install and refused when it fires, and the event still fires', () => {
        const writing = row({ fx: { summary: 'x', writes: [{ path: 'Cast', key: 'Ann', set: { Mood: 'happy' } }] } });
        expect(unallowedWritePaths({ triggers: { w: writing } }, []).length).toBeGreaterThan(0);
        const sd = state({ w: writing });
        sd.Intent.eventFire[0] = 'w';
        const r = load().resolveTurn(sd, {});
        expect(sd.Cast).toBeUndefined();
        expect(r.log.some((line) => line.startsWith('WRITE REFUSED (path not declared): Cast'))).toBe(true);
        expect(sd.EventPack.fired.w.state).toBe('done');
    });
    it('a row naming a scope the engine does not list is reported at install, as the guide says', () => {
        const scoped = row({ fx: { summary: 'x', scope: 'arc' } });
        expect(undeclaredScopeRows({ triggers: { s: scoped } }, []).length).toBeGreaterThan(0);
    });
    it('the library\'s warnings reach the turn\'s log', () => {
        const sd = state({ p: row({ when: 'Present(Ann)' }) });
        const r = load().resolveTurn(sd, {});
        expect(r.log.some((line) => line.startsWith('eventpack: '))).toBe(true);
    });
    it('without the library it says so and changes nothing', () => {
        const api = executeEngineText(code, {});
        const sd = state({ my_first: row() });
        const r = api.resolveTurn(sd, {});
        expect(r.applied).toBe(false);
        expect(r.log[0]).toMatch(/eventpack\.cjs is not loaded/);
        expect(sd.EventPack.armed[0]).toBe('');
    });
});

describe('the plugin skeleton names its panel slot without shipping one', () => {
    const built = build('plugin');
    it('panel/ carries only a README, so the folder exists and pack.panel does not', () => {
        expect(built.members.some((m) => m.path.endsWith('panel/README.txt'))).toBe(true);
        expect(built.members.some((m) => m.path.endsWith('panel/panel.json'))).toBe(false);
        expect(assembleOf(built).pack.panel).toBeUndefined();
    });
    it('its schema declares the platform roots open, and the folder still validates', () => {
        const schema = memberText(built, 'schema/plugin_root_schema.js');
        expect(schema).toContain('GameLogicPlugin: z.record(z.string(), z.any())');
        expect(schema).toContain('$mvuhelper: z.record(z.string(), z.any())');
        expect(memberText(built, 'schema/README.txt')).toContain('Declare the platform roots, GameLogicPlugin and $mvuhelper');
        expect(validatePack(assembleOf(built).pack).ok).toBe(true);
    });
    it('the README says what a panel.json is and that logic is refused inside it', () => {
        const text = memberText(built, 'panel/README.txt');
        expect(text).toContain('slot-list');
        expect(text).toContain('customLogic');
        expect(text).toContain('renderPanel');
    });
});

describe('refusals and identity helpers', () => {
    it('an unknown type and missing fields are named, nothing built', () => {
        const bad = buildBlankArtifactMembers({ packType: 'lorebook', id: '', name: 'x', description: '', builtWith: '' });
        expect(bad.members).toEqual([]);
        expect(bad.errors.some((e) => e.includes('lorebook'))).toBe(true);
        expect(bad.errors.some((e) => e.includes('"id"'))).toBe(true);
        expect(bad.errors.some((e) => e.includes('"description"'))).toBe(true);
    });
    it('a bad id is refused by the REAL validator through the pipeline, not by a second copy of rule 1', () => {
        const built = build('gamelogic', { id: 'My Game' });
        expect(built.errors).toEqual([]);   // this module does not own the kebab rule…
        const v = validatePack(assembleOf(built).pack);
        expect(v.ok).toBe(false);           // …the one validator does
        expect(v.errors.some((e) => e.includes('kebab-case'))).toBe(true);
    });
    it('deriveArtifactId: prefill only — lowercases, hyphenates, trims', () => {
        expect(deriveArtifactId('My Game!  v2')).toBe('my-game-v2');
        expect(deriveArtifactId('  ---  ')).toBe('');
    });
});

describe('MUTATION — the pre-download pipeline actually refuses a broken skeleton (L6)', () => {
    const tamper = (built, tail, fn) => ({
        ...built,
        members: built.members.map((m) => (m.path.endsWith(tail) ? { ...m, text: fn(m.text) } : m)),
    });
    it('engine version header stripped ⇒ rule 3 fails the validate', () => {
        const built = tamper(build('gamelogic'), 'engine/gameLogic.cjs', (t) => t.replace('v0.1.0', ''));
        const v = validatePack(assembleOf(built).pack);
        expect(v.ok).toBe(false);
        expect(v.errors.some((e) => e.includes('rule 3'))).toBe(true);
    });
    it('sidecar type flipped to the boolean trap ⇒ the assembler refuses it', () => {
        const built = tamper(build('gamelogic'), 'example-window.json',
            (t) => JSON.stringify({ ...JSON.parse(t), type: undefined, constant: true }, null, 2));
        expect(assembleOf(built).errors.some((e) => e.includes('boolean'))).toBe(true);
    });
    it('shell member gutted of its script_name ⇒ rule 10 fails the validate', () => {
        const built = tamper(build('statusmenu'), 'regex/StatusMenu.json',
            (t) => JSON.stringify({ ...JSON.parse(t), script_name: '' }, null, 2));
        const v = validatePack(assembleOf(built).pack);
        expect(v.ok).toBe(false);
        expect(v.errors.some((e) => e.includes('rule 10'))).toBe(true);
    });
    it('the folder strip is load-bearing — a wrong folder leaves no pack.json to assemble', () => {
        const built = build('plugin');
        const a = assembleArtifactSource(artifactRootMembers(built.members, 'plugin-wrong'));
        expect(a.pack).toBe(null);
    });
});

describe('the ZIP container, parsed back (the builder suite\'s structural walk, ported)', () => {
    const built = build('statusmenu');
    const bytes = buildStoredZip(built.members);
    const rd16 = (o) => bytes[o] | (bytes[o + 1] << 8);
    const rd32 = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
    const dec = new TextDecoder();
    const found = [];
    let at = 0, sane = true;
    while (at + 4 <= bytes.length && rd32(at) === 0x04034b50) {
        const nameLen = rd16(at + 26), extraLen = rd16(at + 28), size = rd32(at + 22);
        const name = dec.decode(bytes.slice(at + 30, at + 30 + nameLen));
        const data = bytes.slice(at + 30 + nameLen + extraLen, at + 30 + nameLen + extraLen + size);
        if (rd16(at + 8) !== 0) sane = false;                      // stored, never compressed
        if (crc32(data) !== rd32(at + 14)) sane = false;           // CRC honest
        found.push({ name, text: dec.decode(data) });
        at += 30 + nameLen + extraLen + size;
    }
    it('every member parses back stored with an honest CRC', () => {
        expect(sane).toBe(true);
        expect(found.length).toBe(built.members.length);
    });
    it('member texts survive the container byte for byte, under the workspace folder', () => {
        for (const m of built.members) {
            expect(m.path.startsWith('statusmenu/')).toBe(true);
            expect(found.find((f) => f.name === m.path)?.text).toBe(m.text);
        }
    });
    it('the end-of-central-directory record counts them', () => {
        expect(rd32(bytes.length - 22)).toBe(0x06054b50);
        expect(rd16(bytes.length - 12)).toBe(built.members.length);
    });
    it('deterministic — same members, same bytes', () => {
        expect(Buffer.compare(Buffer.from(bytes), Buffer.from(buildStoredZip(built.members)))).toBe(0);
    });
});

describe('W9 — regex-order.json is the ORDER, not a regex (§2.8/§28)', () => {
    const files = (order) => [
        { path: 'pack.json', text: JSON.stringify({ format: '1.0', packType: 'statusmenu', id: 'm', name: 'M', description: 'd', version: '1.0' }) },
        { path: 'regex/StatusMenu.json', text: JSON.stringify({ script_name: 'StatusMenu', find_regex: '/a/' }) },
        { path: 'regex/_GameStartMenu__.json', text: JSON.stringify({ script_name: 'GameStartMenu', find_regex: '/b/' }) },
        ...(order === undefined ? [] : [{ path: 'regex/regex-order.json', text: JSON.stringify(order) }]),
    ];

    it('declared order beats filename order, and the section lands on the pack', () => {
        const a = assembleArtifactSource(files(['GameStartMenu', 'StatusMenu']));
        expect(a.errors).toEqual([]);
        expect(a.pack.regexOrder).toEqual(['GameStartMenu', 'StatusMenu']);
        expect(a.pack.regex.map((r) => r.script_name)).toEqual(['GameStartMenu', 'StatusMenu']);
        expect(validatePack(a.pack).ok).toBe(true);
    });
    it('absent, everything stays filename-sorted with no section — the declaration is the opt-in', () => {
        const a = assembleArtifactSource(files(undefined));
        expect(a.pack.regexOrder).toBeUndefined();
        expect(a.pack.regex.map((r) => r.script_name)).toEqual(['StatusMenu', 'GameStartMenu']);
    });
    it('a non-array file is refused as source, never parsed as a regex object', () => {
        const a = assembleArtifactSource(files({ oops: 1 }));
        expect(a.errors.some((e) => e.includes('regex-order.json'))).toBe(true);
        expect((a.pack.regex || []).length).toBe(2);   // the real regexes still assembled
    });
    it('MUTATION target — an INCOMPLETE listing assembles but rule 14 refuses the pack', () => {
        const a = assembleArtifactSource(files(['GameStartMenu']));
        expect(a.errors).toEqual([]);                  // one run reports every problem…
        const v = validatePack(a.pack);
        expect(v.ok).toBe(false);                      // …and the validator names this one
        expect(v.errors.some((e) => e.includes('rule 14') && e.includes('StatusMenu'))).toBe(true);
    });
});
