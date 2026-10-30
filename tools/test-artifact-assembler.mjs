// tools/test-artifact-assembler.mjs — W2: the ONE artifact-source assembler, proven two ways.
//
// HALF 1 (always runs): every source-form guard killed by a broken in-memory folder — each mutation
// must FAIL naming the offending file, and the clean fixture must assemble with zero errors (L6:
// a guard never seen to fail is not known to be a guard).
//
// HALF 2 (sibling fixture): School v4's real workspace assembles through THIS module and through
// School's own throwaway `Tools/assemble_workspace.cjs`, and the two artifacts must be DEEP-IDENTICAL
// — the drift guard that lets School's copy exist until its gates can consume this module. Both
// artifacts must then pass mvu-helper's own validatePack with zero errors, which is the real bar:
// the folder a developer edits produces the exact object the install lane accepts.
// Sibling-repo absence is a loud SKIP, never a pass (the BV6 convention).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { assembleArtifactSource, splitWorkspaceSources } from '../src/shared/artifact-source-assembler.js';
import { validatePack, PACK_TYPES } from '../src/features/gamelogic-pack/gamelogic-pack-core.js';
import { filterSchemaScript } from '../src/features/gamelogic-pack/gamelogic-pack-schema-allowlist.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const failures = [];
const check = (label, ok, detail) => {
    if (ok) { pass++; console.log('  ok   ' + label); }
    else { failures.push(label); console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};

// ── half 1: guards, each proven by mutation ──────────────────────────────────
console.log('guards (in-memory)');

const CLEAN = [
    { path: 'pack.json', text: JSON.stringify({ format: '1.0', packType: 'gamelogic', id: 'probe', name: 'Probe', description: 'guard fixture', version: '1.0', engineOrder: ['a.cjs', 'b.cjs'] }) },
    { path: 'engine/a.cjs', text: '// a\n' },
    { path: 'engine/b.cjs', text: '// b\n' },
    { path: 'entries/lore/Airi.txt', text: 'profile text' },
    { path: 'entries/lore/Airi.json', text: JSON.stringify({ comment: '[Character] Airi', type: 'selective', keys: ['Airi'], order: 10, enabled: true }) },
    { path: 'entries/windows/output.txt', text: '<Reply_Request>rules</Reply_Request>' },
    { path: 'entries/windows/output.json', text: JSON.stringify({ comment: 'Reply_Request', type: 'constant', order: 990, enabled: true }) },
    { path: 'regex/Hide.json', text: JSON.stringify({ id: 'x', script_name: 'Hide', find_regex: 'a', replace_string: '' }) },
    { path: 'schema/statdata_schema.js', text: 'const s = 1;\n' },
    { path: '.gitkeep', text: '' },
];
const mutate = (files, drop, add) => files.filter((f) => f.path !== drop).concat(add ? [add] : []);
const run = (files) => assembleArtifactSource(files);

{
    const r = run(CLEAN);
    check('clean fixture: zero errors', r.errors.length === 0, r.errors[0]);
    check('engine is a.cjs + b.cjs in order', r.pack.engine === '// a\n// b\n');
    check('entry assembled as sidecar + content', r.pack.entries.length === 2 && r.pack.entries[0].content === 'profile text' && r.pack.entries[0].keys[0] === 'Airi');
    check('engineOrder consumed, never emitted', !('engineOrder' in r.pack));
    check('order listing derived and sorted', r.orderListing.length === 2 && r.orderListing[0].order === 10 && r.orderListing[1].comment === 'Reply_Request');
    check('dotfiles ignored', !r.errors.some((e) => e.includes('.gitkeep')));
}

const expectError = (label, files, needle) => {
    const r = run(files);
    check(label, r.errors.some((e) => e.includes(needle)), 'no error names "' + needle + '": ' + JSON.stringify(r.errors));
};

expectError('no pack.json refused', CLEAN.filter((f) => f.path !== 'pack.json'), 'no pack.json');
expectError('broken pack.json named', mutate(CLEAN, 'pack.json', { path: 'pack.json', text: '{oops' }), 'pack.json is not valid JSON');
expectError('engineOrder naming a missing file', mutate(CLEAN, 'engine/b.cjs'), 'engineOrder names "b.cjs"');
expectError('engine file absent from engineOrder', CLEAN.concat([{ path: 'engine/orphan.cjs', text: 'x\n' }]), 'engine/orphan.cjs is not named in engineOrder');
expectError('.txt with no sidecar', mutate(CLEAN, 'entries/lore/Airi.json'), 'entries/lore/Airi.txt has no .json sidecar');
expectError('.json with no .txt', mutate(CLEAN, 'entries/lore/Airi.txt'), 'entries/lore/Airi.json has no .txt');
expectError('sidecar carrying content', mutate(CLEAN, 'entries/lore/Airi.json', { path: 'entries/lore/Airi.json', text: JSON.stringify({ comment: 'x', content: 'inline' }) }), 'carries "content"');
expectError('sidecar carrying uid', mutate(CLEAN, 'entries/lore/Airi.json', { path: 'entries/lore/Airi.json', text: JSON.stringify({ comment: 'x', uid: 3 }) }), 'carries "uid"');
expectError('boolean constant refused with the type it meant', mutate(CLEAN, 'entries/lore/Airi.json', { path: 'entries/lore/Airi.json', text: JSON.stringify({ comment: 'x', constant: true }) }), 'type: "constant"');
expectError('sidecar that is not an object', mutate(CLEAN, 'entries/lore/Airi.json', { path: 'entries/lore/Airi.json', text: '[1]' }), 'must be a JSON object');
expectError('stray file at the artifact root', CLEAN.concat([{ path: 'notes.txt', text: 'hi' }]), 'unexpected file at the artifact folder root');
// README files are documentation FOR the developer and are IGNORED anywhere in the tree (28.1 —
// the W8 skeletons ship them beside placeholder files). The ignore is NARROW: the stray cases
// above still error, so this is not a general stray-swallower.
{
    const withReadmes = CLEAN.concat([
        { path: 'README.md', text: 'root doc' },
        { path: 'layout/README.txt', text: 'authored in the builder' },
        { path: 'regex/README.txt', text: 'generated shell' },
    ]);
    const res = assembleArtifactSource(withReadmes);
    check('README.txt / README.md ignored at any depth', res.errors.length === 0, res.errors);
}
expectError('unknown directory named', CLEAN.concat([{ path: 'lorebooks/x.txt', text: 'x' }]), 'unknown directory "lorebooks/"');
expectError('non-entry extension inside entries/', CLEAN.concat([{ path: 'entries/lore/pic.png', text: 'x' }]), 'entries/lore/pic.png is neither');
expectError('layout/ with a wrong filename', CLEAN.concat([{ path: 'layout/menu.json', text: '{}' }]), 'the one file this format reads there is layout.json');
expectError('regex/ non-json refused', CLEAN.concat([{ path: 'regex/notes.txt', text: 'x' }]), 'regex/notes.txt is not a .json');
expectError('two schema files refused', CLEAN.concat([{ path: 'schema/second.js', text: 'x' }]), 'schema/ holds 2 files');
expectError('panel/ with a wrong filename', CLEAN.concat([{ path: 'panel/slot.json', text: '{}' }]), 'the one file this format reads there is panel.json');

// plans/plugin-sidepanel.md §3 — panel/panel.json assembles into pack.panel for the two types that may
// carry one (plugin, gamelogic); a StatusMenu Pack is refused by the VALIDATOR, never here, because
// which sections a type may carry is §3's table and the assembler consults nothing.
{
    const PANEL = { kind: 'slot-list', format: '1.0', title: 'Outfits', tabs: [{ id: 't', name: 'T', blocks: [] }] };
    const PLUGIN = [
        { path: 'pack.json', text: JSON.stringify({ format: '1.0', packType: 'plugin', id: 'outfit-probe', name: 'Outfit Probe', description: 'panel fixture', version: '0.1' }) },
        { path: 'entries/narrate.txt', text: 'outfit table' },
        { path: 'entries/narrate.json', text: JSON.stringify({ comment: 'outfit narrate', type: 'constant', order: 800, enabled: true }) },
        { path: 'panel/panel.json', text: JSON.stringify(PANEL) },
        // Rule 7 asks a schema of every plugin, so the fixture ships one: without it this block would
        // measure the panel assembly against a file the validator refuses for an unrelated reason.
        // The root is OPEN because rule 7b asks that too — a plugin never owns stat_data, so a closed
        // root would strip every root the plugin did not name. A fixture written to satisfy one rule has
        // to satisfy the others, or it measures the thing under test against an unrelated refusal again.
        { path: 'schema/plugin_root_schema.js', text: 'registerMvuSchema(z.looseObject({ GameLogicPlugin: z.record(z.string(), z.any()) }));' },
    ];
    const r = run(PLUGIN);
    check('plugin with panel/panel.json assembles clean', r.errors.length === 0, r.errors[0]);
    check('panel/panel.json lands as pack.panel, whole', JSON.stringify(r.pack.panel) === JSON.stringify(PANEL));
    const v = validatePack(r.pack);
    check('and the assembled plugin passes validatePack', v.ok, JSON.stringify(v.errors));
    // The same folder under a GAMELOGIC pack is legal — the CLEAN fixture is one, minus its engine
    // (whose missing version header is rule 3's business, not this check's).
    const { engineOrder: _drop, ...glHeader } = JSON.parse(CLEAN.find((f) => f.path === 'pack.json').text);
    const gl = run(CLEAN
        .filter((f) => !f.path.startsWith('engine/') && f.path !== 'pack.json')
        .concat([{ path: 'pack.json', text: JSON.stringify(glHeader) }, { path: 'panel/panel.json', text: JSON.stringify(PANEL) }]));
    check('panel/ under a gamelogic pack assembles', gl.errors.length === 0, gl.errors[0]);
    const vg = validatePack(gl.pack);
    check('and the VALIDATOR accepts it — a pack owns state worth showing too', vg.ok, JSON.stringify(vg.errors));
    const vm = validatePack({ ...gl.pack, packType: 'statusmenu', targetsPackId: 't' });
    check('a StatusMenu Pack carrying one is refused — its display declaration is `layout`',
        !vm.ok && vm.errors.some((e) => e.startsWith('rule 2:') && e.includes('"panel"')), JSON.stringify(vm.errors));
}

{
    const r = run(mutate(CLEAN, 'engine/a.cjs', { path: 'engine/a.cjs', text: '// a (no newline)' }));
    check('missing trailing newline on a non-final engine member WARNS', r.warnings.some((w) => w.includes('engine/a.cjs') && w.includes('newline')), JSON.stringify(r.warnings));
}
{
    const ws = [
        { path: 'gamelogic/pack.json', text: '{}' }, { path: 'gamelogic/engine/a.cjs', text: '' },
        { path: 'statusmenu/pack.json', text: '{}' },
        { path: 'notes/scratch.txt', text: '' },
    ];
    const split = splitWorkspaceSources(ws);
    check('workspace split finds the two artifacts and skips the non-artifact dir', split.length === 2 && split.map((a) => a.name).sort().join(',') === 'gamelogic,statusmenu');
    check('artifact files re-rooted', split.find((a) => a.name === 'gamelogic').files.some((f) => f.path === 'engine/a.cjs'));
    const single = splitWorkspaceSources([{ path: 'pack.json', text: '{}' }, { path: 'engine/a.cjs', text: '' }]);
    check('pack.json at the root means ONE artifact', single.length === 1 && single[0].name === '');
}

// events/ — an eventpack artifact IS this directory. Read verbatim and FLATTENED: the format belongs
// to the event-pack feature and this assembler runs in node, so nothing here parses one. Sub-folders
// are a route's own filing, never structure this reads.
{
    const EVENTS = [
        { path: 'pack.json', text: JSON.stringify({ format: '1.0', packType: 'eventpack', id: 'mitsuki-route-1', name: 'Mitsuki Route 1', description: 'events fixture', version: '1.0' }) },
        { path: 'events/opening.txt', text: '<mvueventpack>{"one":1}</mvueventpack>' },
        { path: 'events/arc-two/later.txt', text: '<mvueventpack>{"two":2}</mvueventpack>' },
        { path: 'events/README.md', text: 'notes for the developer, read by nothing' },
        { path: 'events/.DS_Store', text: '' },
    ];
    const r = run(EVENTS);
    check('eventpack: zero assembly errors', r.errors.length === 0, r.errors[0]);
    check('events/ lands as pack.events, sub-folder FLATTENED', r.pack.events.length === 2);
    check('event name is the path under events/, so two same-named files in different folders stay distinct',
        r.pack.events.map((e) => e.name).join('|') === 'arc-two/later.txt|opening.txt');
    check('event text is carried verbatim, never parsed', r.pack.events[1].text === '<mvueventpack>{"one":1}</mvueventpack>');
    check('README and dotfiles under events/ are not events', !r.pack.events.some((e) => /README|DS_Store/.test(e.name)));

    // MUTATION TARGET — drop every file under events/ and the section must VANISH, not arrive empty.
    // An empty array would read as "an eventpack with no events", which rule 2b refuses by name; an
    // absent section is what makes that refusal fire.
    const none = run(EVENTS.filter((f) => !f.path.startsWith('events/')));
    check('MUTATION TARGET — no events/ files means no events section at all', none.pack.events === undefined);

    // events/ is a DECLARED directory now, so it must not read as the unknown-directory error that
    // every other invented folder gets.
    check('events/ is not reported as an unknown directory', !r.errors.some((e) => e.includes('unknown directory')));
    expectError('an invented directory is still refused', EVENTS.concat([{ path: 'lorebooks/x.txt', text: '' }]), 'unknown directory "lorebooks/"');
}

// ── half 2: School v4, the worked example ────────────────────────────────────
console.log('School v4 fixture (sibling repo)');
const schoolRoot = path.resolve(root, '..', 'MVU_Game_Maker-dev', 'maker-app', 'GameLogic', 'Schoolv4');
if (!existsSync(path.join(schoolRoot, 'workspace'))) {
    console.log('  SKIP — sibling repo not found at ' + schoolRoot + ' (NOT a pass: the fixture half did not run)');
} else {
    const readTree = (dir, base = '') => {
        const out = [];
        for (const name of readdirSync(dir)) {
            const p = path.join(dir, name);
            if (statSync(p).isDirectory()) out.push(...readTree(p, base + name + '/'));
            else out.push({ path: base + name, text: readFileSync(p, 'utf8') });
        }
        return out;
    };
    const canon = (v) => (v === null || typeof v !== 'object') ? v
        : Array.isArray(v) ? v.map(canon)
            : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
    const require2 = createRequire(import.meta.url);
    const schoolAssemble = require2(path.join(schoolRoot, 'Tools', 'assemble_workspace.cjs')).assemble;

    // The artifacts are DISCOVERED by the module under test, never listed here. A hardcoded list
    // freezes the fixture: School gained a second plugin on 2026-08-29 and the list would have
    // compared three of four artifacts while reading green — and it did worse than that, because the
    // renamed folder made it read a path that no longer existed and the whole suite died.
    const split = splitWorkspaceSources(readTree(path.join(schoolRoot, 'workspace')));
    const names = split.map((a) => a.name).sort();
    // The SHAPE is the invariant, not the membership (workflow §2.1): one gamelogic, one statusmenu,
    // and as many plugin-<name> as the card runs.
    // Judged by what each folder DECLARES, not by what it is called: a workspace grows artifacts
    // (an eventpack route, a second plugin) and a name-shaped assertion would fail on arrival for a
    // workspace that is perfectly correct. The two the card cannot work without are still named.
    const declaredTypes = names.map((n) => {
        const r = assembleArtifactSource(split.find((a) => a.name === n).files);
        return { name: n, packType: (r.pack && r.pack.packType) || '(none)' };
    });
    check('every workspace folder declares a known packType (found: ' + declaredTypes.map((d) => d.name + '=' + d.packType).join(', ') + ')',
        declaredTypes.every((d) => PACK_TYPES.includes(d.packType)),
        'unknown packType: ' + JSON.stringify(declaredTypes.filter((d) => !PACK_TYPES.includes(d.packType))));
    check('the two artifacts this card cannot work without are there',
        declaredTypes.some((d) => d.packType === 'gamelogic') && declaredTypes.some((d) => d.packType === 'statusmenu'));

    for (const artifact of names) {
        const mine = assembleArtifactSource(split.find((a) => a.name === artifact).files);
        check(artifact + ': zero assembly errors', mine.errors.length === 0, mine.errors[0]);
        const theirs = schoolAssemble(artifact);
        check(artifact + ': identical to School\'s own assembly', JSON.stringify(canon(mine.pack)) === JSON.stringify(canon(theirs)),
            'the two assemblers DISAGREE — one of them drifted');
        const v = validatePack(mine.pack);
        check(artifact + ': validatePack accepts with zero errors', v.errors.length === 0, v.errors[0]);
        // A real schema must reach the card whole: anything the allow-list removes is a piece of the
        // game that silently stops installing.
        if (typeof mine.pack.schema === 'string') {
            const filtered = filterSchemaScript(mine.pack.schema);
            check(artifact + ': the schema allow-list keeps the whole schema', filtered.text === mine.pack.schema,
                filtered.removals.map((r) => 'line ' + r.line + ' ' + r.what + ' — ' + r.why).join(' · ') || filtered.failure);
        }
    }
    const gl = assembleArtifactSource(split.find((a) => a.name === 'gamelogic').files);
    // The DERIVATION, never a count. orderListing is one row per entry, so a pinned number states
    // how much content School HAS — a consumer's inventory asserted by the platform's own suite,
    // which then fails for every entry that repo legitimately adds. The fixture half above may pin
    // counts because it owns its fixture; this half reads a live sibling repo and owns nothing in it.
    check('order table has one row per entry, sorted',
        gl.orderListing.length === gl.pack.entries.length
        && gl.orderListing.every((r, i, a) => i === 0 || (a[i - 1].order ?? 0) <= (r.order ?? 0)),
        gl.orderListing.length + ' rows vs ' + gl.pack.entries.length + ' entries, or rows out of order');
}

console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) { console.error('ARTIFACT ASSEMBLER SUITE FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
