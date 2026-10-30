// shared/artifact-skeletons.js — the blank-artifact source folders behind "Add New Blank Packs"
// (the cold start). PURE: identity in, archive members out.
//
// It lives in shared/ for the same reason artifact-source-assembler.js does: the table spans all
// three artifact types, so no single feature owns it, and the packs-tab UI that consumes it must
// stay ignorant of what the other lanes are (it imports shared, never a sibling feature).
//
// THE GUARANTEE: every skeleton is fed through assembleArtifactSource + validatePack in the
// test suite, and the UI runs the SAME pipeline before offering the download — a skeleton that
// stops matching the format fails CI here instead of failing a stranger on their first day. That
// is also why this module validates almost nothing itself: the id's kebab rule, the engine's
// version header, the sections-per-type table all get judged by the one real validator, never by a
// second copy of its rules.
//
// Four fields, because only four are unguessable: packType, id, name, description.
// `format` is derived (letting a developer type it would teach it wrong on day one), `version`
// starts at 0.1.0, `builtWith` is stamped by the caller. Every skeleton is minimal but WORKING:
// engines carry the version header rule 3 demands and export the function their lane calls;
// example entries ship DISABLED with a .txt that says what goes there — a blank install must put
// nothing into anyone's prompt.
//
// Members are rooted under a top-level folder (gamelogic/ · statusmenu/ · plugin-<id>/ — the
// workspace's folder naming, which only the archive can deliver), so the developer extracts at the
// WORKSPACE root and the folder arrives named. This is the one place the skeleton archive differs
// from the builder's bootstrap archive, which is rooted at the artifact folder itself.

import { PLACEHOLDER_SHELL_REGEX } from './placeholder-menu-shell.js';

// ── identity helpers ─────────────────────────────────────────────────────────

// Prefill for the id field, derived from the display name (the builder's habit: derive, then
// let the author edit). NOT a validator — whatever the field holds goes through validatePack's
// rule 1, whose kebab-case refusal is the single source of that rule.
export function deriveArtifactId(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
}

const packJsonText = (fields) => JSON.stringify(fields, null, 2) + '\n';
const sidecarText = (sidecar) => JSON.stringify(sidecar, null, 2) + '\n';

// ── per-type skeletons — ONE table row per artifact type (the list is DATA) ──────────────────────

// A disabled example entry: the sidecar demonstrates the pairing and the string `type` (the
// boolean-`constant` trap is refused by the assembler; the string spelling here is what survives),
// the .txt says what belongs in it. `enabled: false` so a fresh install injects nothing into the
// narrator's prompt; a scaffold meant for a PRE or POST call also carries no call token yet, because
// routing reads the comment, never `enabled`.
function exampleEntry(dir, stem, comment, text, type = 'constant') {
    return [
        { path: dir + '/entries/' + stem + '.txt', text },
        {
            path: dir + '/entries/' + stem + '.json',
            text: sidecarText({ comment, order: 100, position: 'before_character_definition', type, enabled: false, keys: [] }),
        },
    ];
}

// A sample display regex for the gamelogic skeleton. Blanks the DISPLAY of anything at depth 10 or
// deeper — a real, genre-neutral technique (long chats get unreadable) that also demonstrates the
// three fields most often got wrong: `script_name` is the IDENTITY (unique per pack, never the
// filename), `find_regex` is /pattern/flags (the `s` flag is what makes `.` span newlines), and
// `destination` decides whether a regex edits the SCREEN or what the model reads.
const SAMPLE_REGEX = {
    id: '5b1e7c02-9a4d-4f38-b6e1-2c8f0d374a95',
    script_name: 'HideFarFloor',
    enabled: true,
    find_regex: '/.*/s',
    replace_string: '',
    trim_strings: [],
    source: { user_input: true, ai_output: true, slash_command: false, world_info: false, reasoning: false },
    destination: { display: true, prompt: false },
    run_on_edit: true,
    min_depth: 10,
    max_depth: null,
};

// A sample Zod registration script — the smallest one that actually REGISTERS. Three things here are
// load-bearing and are the three a trimmed-down copy loses first: the base atoms the field helpers are
// built from (drop them and the file throws ReferenceError at import), a top-level schema describing
// the VALUE of stat_data directly, and the registerMvuSchema CALL (import without call = a schema that
// silently validates nothing). The platform roots, GameLogicPlugin and mvu-helper's own $mvuhelper, ship declared
// OPEN — rule 7 refuses a closed one, because installed plugins and mvu-helper name their own keys inside them.
//
// GENRE-BLIND (L1): `Cast` is a placeholder root, not any game's vocabulary.
const SAMPLE_SCHEMA = [
    "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';",
    '// zod and lodash are available globally as `z` and `_`',
    '',
    '/**',
    ' * IMPORTANT:',
    ' * Your MVU variable name is `stat_data`.',
    ' * Therefore the schema MUST describe the VALUE of that variable directly — every root your game',
    ' * writes has to appear in the top-level object at the bottom of this file, or it is stripped.',
    ' */',
    '',
    '// -------------------------',
    '// Base atoms',
    '// -------------------------',
    "const strEmpty = z.string().prefault('');",
    'const num0 = z.coerce.number().prefault(0);',
    'const boolFalse = z.coerce.boolean().prefault(false);',
    '',
    '// -------------------------',
    '// "Labeled" field helper: [value, label]',
    '// -------------------------',
    "const labeledStr = z.tuple([strEmpty, strEmpty]).prefault(['', '']);",
    "const labeledNum = z.tuple([num0, strEmpty]).prefault([0, '']);",
    "const labeledBool = z.tuple([boolFalse, strEmpty]).prefault([false, '']);",
    '',
    '// -------------------------',
    '// Cast (Collection) — a placeholder root. Rename it, and give it your own fields.',
    '// -------------------------',
    'const castMemberSchema = z',
    '  .object({',
    '    Name: labeledStr,',
    '    Age: labeledStr,',
    '    Gender: labeledStr,',
    '    Affinity: labeledNum,',
    '    Is_present: labeledBool,',
    '  })',
    '  .prefault({});',
    '',
    'const castSchema = z.record(z.string(), castMemberSchema).prefault({});',
    '',
    '// -------------------------',
    '// stat_data itself',
    '//',
    '// LOOSE, and never `.prefault({})` on this root. `z.object` drops a key it was never told about,',
    '// and your pack is not the only writer on the card: mvu-helper keeps $mvuhelper and GameLogicPlugin,',
    '// a plugin names its own drawer inside GameLogicPlugin, and a later artifact may add a root of its own.',
    '// mvu_zod does re-wrap a registered root as looseObject for that reason \u2014 but only when it is',
    '// `instanceof z.ZodObject`, and a prefault is not one, so the rewrap silently does not fire and every',
    '// write into a root you did not name is dropped. Declaring it loose here does not depend on the rewrap.',
    '// Closing the root ON PURPOSE is allowed \u2014 freezing the top level so nobody can invent',
    '// stat_data.<key> at will \u2014 but only alongside the two platform-root declarations below. Rule 7b',
    '// warns there instead of refusing: what a lock still costs is every root that arrives LATER, and',
    '// nothing logs the loss.',
    '// -------------------------',
    'const StatDataSchema = z',
    '  .looseObject({',
    '    Cast: castSchema,',
    '    // The plugins\' platform root. DECLARED so tooling sees it exists, OPEN because its keys belong',
    '    // to installed plugins, which name them at install time. A strict shape here would silently',
    '    // strip every plugin state on the next write.',
    '    GameLogicPlugin: z.record(z.string(), z.any()).prefault({}),',
    '    // mvu-helper\'s own platform root: what each character wears, the character registry. OPEN because',
    '    // mvu-helper names its parts as it grows; the leading $ keeps it out of TavernHelper\'s variable macros.',
    '    $mvuhelper: z.record(z.string(), z.any()).prefault({}),',
    '  });',
    '',
    '// -------------------------',
    '// Register — WITHOUT this call nothing above is ever used.',
    '// -------------------------',
    '$(() => {',
    '  registerMvuSchema(StatDataSchema);',
    '});',
    '',
].join('\n');

// A PLUGIN's Zod registration, and the whole of it is one root. A plugin cannot know whether it lands
// on a card with a GameLogic Pack (whose schema already declares the platform roots open — rule 7 makes
// sure of it) or on a bare card with no schema at all, where MVU's own derived schema governs and
// freezes every object to the keys it held at derivation. On that second kind THIS file is the only
// thing standing between the plugin and a drawer that accepts nothing, ever. So every plugin ships one
// and the INSTALLER decides whether the card needs it (rule 7 · decidePluginSchemaInstall).
//
// It names only the platform roots on purpose, each declared open, and the root itself is
// `z.looseObject`, so every OTHER root on the card passes through untouched, which is exactly right for
// an artifact that knows nothing about the game it is installed beside (L1). mvu_zod's own rewrap says
// the same thing, but it fires only on a root that is `instanceof z.ZodObject`: wrap the root in
// `.prefault({})` and it is a ZodPrefault, the rewrap does not fire, and a plugin schema that names only
// the platform roots then throws away every write into a game root (zod 4.4.3). That is why the skeleton
// states the looseness instead of relying on the bridge to add it.
const PLUGIN_ROOT_SCHEMA = "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';\n// zod and lodash are available globally as `z` and `_`\n\n/**\n * Your MVU variable name is `stat_data`, so this describes the VALUE of that variable directly.\n *\n * The platform roots are declared, and nothing else: GameLogicPlugin, the namespace every installed\n * plugin keeps its state in, and $mvuhelper, mvu-helper's own. Both are OPEN because the keys inside\n * them are chosen by someone else (one drawer per plugin, named at INSTALL time; mvu-helper's parts)\n * — a closed shape here strips them on the next write.\n *\n * THE ROOT ITSELF IS `looseObject`, and must stay that way: a plain `z.object` root drops every key\n * it was never told about, and this file names only the platform roots — so on a card where it is the\n * only schema, a strict root throws away every write into the game's own roots. Never wrap it in `.prefault({})`\n * either: mvu_zod re-wraps a root as looseObject only when it is `instanceof z.ZodObject`, and a\n * prefault is not one, so the rewrap silently does not fire.\n *\n * DO NOT add a GAME root here. A plugin that describes a game it was not written for is a plugin\n * that breaks the next card it is installed on.\n */\nconst StatDataSchema = z\n  .looseObject({\n    GameLogicPlugin: z.record(z.string(), z.any()).prefault({}),\n    $mvuhelper: z.record(z.string(), z.any()).prefault({}),\n  });\n\n// -------------------------\n// Register — WITHOUT this call nothing above is ever used.\n// -------------------------\n$(() => {\n  registerMvuSchema(StatDataSchema);\n});\n";

// Where a developer downloads eventpack.cjs. The public repository that will carry it is not published
// yet, so the guide says so rather than naming a link that does not exist.
const EVENTPACK_DOWNLOAD = '(link to come: the public repository that will carry it is not published yet)';

// The markers around the guide's gameLogic.cjs. The suite runs the code between them against the real
// eventpack.cjs, so a sample that stops working fails CI instead of a developer's first event.
export const EVENT_GUIDE_CODE_START = '----- gameLogic.cjs, with event packs wired in -----';
export const EVENT_GUIDE_CODE_END = '----- end of gameLogic.cjs -----';

// engine/README.txt of the gamelogic skeleton: how to add event packs. The skeleton does not ship
// eventpack.cjs itself — mvu-helper does not carry another repo's file — so this names where it comes
// from and shows the whole wiring. A README, because the assembler reads nothing else in engine/
// except what engineOrder names.
function eventPackGuide({ id, name }) {
    const code = `// ${name} GameLogic Engine, with event packs wired in.
const ENGINE_VERSION = 'v0.2.0';
const ENGINE_NAME = '${id}';
const ENGINE_TYPE = '${id}';

// eventpack.cjs ran first (pack.json engineOrder) and left its functions here.
const EVENTS = globalThis.__EVENTPACK__ || null;

// A value in MVU state is often a [value, label] pair: read the value, keep the label on a write.
function get(v, d) {
    const x = Array.isArray(v) && v.length === 2 && typeof v[1] === 'string' ? v[0] : v;
    return x === undefined || x === null ? d : x;
}
function setValue(obj, key, v) {
    obj[key] = Array.isArray(obj[key]) ? [v, obj[key][1]] : [v, key];
}

// The library's warnings, handed back in the turn's log.
const warnings = [];

// WHERE this game keeps event state, and what a fired event may do. mvu-helper reads triggerRoot,
// armedPath, writes, rewards and scopes off the export below, and bodyEntry (where an installed pack's
// entry goes in the prompt) when one is declared.
const EVENT_PACK_ADAPTER = {
    triggerRoot: 'EventPack.triggers',
    armedPath: 'EventPack.armed',
    writes: [],
    scopes: [],
    get,
    getArmed: (sd) => String(get(sd.EventPack && sd.EventPack.armed, '')),
    setArmed: (sd, v) => setValue(sd.EventPack || (sd.EventPack = {}), 'armed', v),
    warn: (message) => { warnings.push('eventpack: ' + message); },
};

function resolveTurn(statData, ctx) {
    const log = [];
    let applied = false;
    if (!EVENTS) {
        log.push('eventpack.cjs is not loaded (see engine/README.txt) - no event can arm or fire');
        return { statData, applied, log };
    }
    // The narrator played the armed event: "<key>" or "<key>:<Outcome>".
    const intent = statData.Intent || {};
    const fired = String(get(intent.eventFire, '')).trim();
    let didFire = false;
    if (fired) {
        didFire = EVENTS.applyEventFire(statData, fired, log, EVENT_PACK_ADAPTER);
        setValue(intent, 'eventFire', '');   // consumed, fired or refused: never applied twice
        applied = true;
    }
    // Arm the next event for the next reply. Not in the reply one fired, so a series' next beat waits.
    if (!didFire && EVENTS.scanEvents(statData, log, EVENT_PACK_ADAPTER)) applied = true;
    log.push(...warnings.splice(0));
    return { statData, applied, log };
}

module.exports = {
    ENGINE_VERSION, ENGINE_NAME, ENGINE_TYPE,
    EVENT_PACK_ADAPTER,
    EVENT_PACK_FORMAT: EVENTS ? EVENTS.FORMAT : null,
    resolveTurn,
};`;
    return `EVENT PACKS - adding eventpack.cjs to this engine
=================================================

This engine runs no event packs yet. An event pack (built in MVU Status Menu Builder, installed from
mvu-helper's Event Packs tab) is DATA: rows saying when an event may happen and what it changes.
What RUNS them is eventpack.cjs, one library every game uses unchanged: it checks each row's
conditions, arms the next event, and applies a fired event's writes. Your engine only says where
this game keeps event state, and calls it.

1. GET THE FILE
   eventpack.cjs is MvuGameMaker's maker-app/GameLogic/_engine/eventpack.cjs.
   Download: ${EVENTPACK_DOWNLOAD}
   Save it as engine/eventpack.cjs and never edit it. To update it, replace the whole file.

2. LOAD IT BEFORE YOUR ENGINE (pack.json)
       "engineOrder": ["eventpack.cjs", "gameLogic.cjs"]
   The files in engineOrder run as ONE script, in that order. eventpack.cjs leaves its functions on
   globalThis.__EVENTPACK__, where gameLogic.cjs picks them up.

3. WIRE gameLogic.cjs
   The bare minimum. This whole file replaces the blank gameLogic.cjs and runs events:

${EVENT_GUIDE_CODE_START}
${code}
${EVENT_GUIDE_CODE_END}

   - triggerRoot and armedPath say where the event rows and the armed event live. They must be
     dotted paths. mvu-helper merges every installed pack's rows into triggerRoot.
   - The armed event MUST be a [value, label] pair. MVU Status Menu Builder writes every pack's text
     behind the gate stat_data.<armedPath>[0] === '@key'; on a plain string [0] reads only '@', so
     every event would arm and never show.
   - writes: where a fired event may write, and under which rules. Empty means a pack may arm and
     fire but change nothing: a row's writes are reported at install and refused when it fires,
     and the event itself still fires.
   - scopes: the scope words your game gives a meaning to (for example, what a new playthrough
     clears). A row naming a word not listed here is reported at install.
   - resolveTurn applies a fired event first, otherwise arms the next one. It clears the report
     either way, or the next turn would apply it again.
   Optional, each described in eventpack.cjs's own header: aliases (short spellings for conditions),
   presence (what Present(Name) reads), nowStamp and daysSince (the clock that DaysSince() conditions
   and stamped writes need), rewards (what a fired event may pay). Without them the library warns
   by name instead of guessing.

4. GIVE THE STATE A HOME (schema/)
   Declare both roots in your schema, or MVU strips them on the next write:
       EventPack: z.looseObject({
         triggers: z.record(z.string(), z.any()).prefault({}),
         armed: labeledStr,
       }).prefault({}),
       Intent: z.looseObject({
         eventFire: labeledStr,
       }).prefault({}),
   Keep EventPack open: mvu-helper keeps its install record in EventPack.installed, and the library
   records fired events in EventPack.fired.

5. TELL THE NARRATOR
   A pack's FIRE line asks the narrator to emit /Intent/eventFire "<key>" when it plays the armed
   event. Your card's prompt must say where that lands: here, the value half of the pair,
   /Intent/eventFire/0. That report is the only way the engine learns an event was played.

The full contract is in mvu-helper's devdoc/event-pack-engine.md (this engine's side) and
devdoc/event-pack-format.md (what a pack contains).
`;
}

export const BLANK_ARTIFACT_TYPES = [
    {
        packType: 'gamelogic',
        label: 'GameLogic Pack',
        folder: () => 'gamelogic',
        members({ id, name, description, builtWith }) {
            const dir = 'gamelogic';
            const engine = [
                '// ' + name + ' GameLogic Engine',
                '//',
                '// The engine DECLARES its own identity and exports it. mvu-helper reads these off the',
                '// running module, and reads these same lines when checking a pack that is not loaded',
                '// yet — one source, two readers, so nothing can drift. They must be STRING LITERALS:',
                '// a computed value cannot be read back from source. Bump ENGINE_VERSION on every change;',
                '// it is reported and logged, never compared.',
                "const ENGINE_VERSION = 'v0.1.0';",
                "const ENGINE_NAME = '" + id + "';   // WHICH GAME — the one name plugins branch on",
                "const ENGINE_TYPE = '" + id + "';   // WHICH FAMILY it belongs to, beside the game",
                '//',
                '// resolveTurn IS the game: mvu-helper hosts this text in a Worker and calls it once per',
                '// resolved turn. statData is a structured clone of the chat\'s stat_data — mutate it freely',
                '// and return it; the returned object is the result (mutations never cross the Worker wall',
                '// by reference). ctx carries { mid, swipe, dice, dicePools, ops, sameRoundEventKey }: the',
                '// turn\'s identity, the dice dealt this turn (flat, and per pool as { pool | hash, sides,',
                '// dice }), the ops already applied this turn, and the event whose body mvu-helper injected',
                '// into this reply (\'\' when none) — whether that beat fired is this engine\'s to judge.',
                '// Optional result fields: resBlock (the BODY of a player-visible audit; mvu-helper wraps it',
                '// in its own <RES_Variable> tag), textReplacements ({ find: put } applied to the reply), and',
                '// leadText / endText (text mvu-helper writes at the top of the story and directly above its',
                '// menu, in its own <LeadText> / <EndText> tags, on every reply that returns them; the lead',
                '// text needs the card\'s [Initmvuhelper] leadText section, which names the story block).',
                '// applied: did this resolve change state? log: one human line per thing it did.',
                'module.exports = {',
                '    ENGINE_VERSION, ENGINE_NAME, ENGINE_TYPE,',
                '    resolveTurn(statData, ctx) {',
                '        return { statData, applied: false, log: [] };',
                '    },',
                '};',
                '',
            ].join('\n');
            return [
                {
                    path: dir + '/pack.json',
                    text: packJsonText({ format: '1.0', packType: 'gamelogic', id, name, description, version: '0.1.0', builtWith, engineOrder: ['gameLogic.cjs'] }),
                },
                { path: dir + '/engine/gameLogic.cjs', text: engine },
                { path: dir + '/engine/README.txt', text: eventPackGuide({ id, name }) },
                ...exampleEntry(dir, 'example-window', 'example window',
                    'This entry is a DISABLED example of the source pairing: every entry is a .txt (this text)\n'
                    + 'plus a .json sidecar beside it carrying the same stem — the sidecar is a TavernHelper\n'
                    + 'LorebookEntry minus content. Note its type: "constant" is a STRING; a boolean constant is\n'
                    + 'silently dropped by TavernHelper and the entry never injects. Write your prompt window\n'
                    + 'here, rename the pair by its purpose, and set "enabled": true in the sidecar.\n'),
                { path: dir + '/regex/HideFarFloor.json', text: JSON.stringify(SAMPLE_REGEX, null, 2) + '\n' },
                {
                    path: dir + '/regex/README.txt',
                    text: 'One regex object per .json file; the filename is yours, the IDENTITY is script_name\n'
                        + '(install, upgrade and uninstall all find a regex by that name, so two files may never\n'
                        + 'share one). HideFarFloor.json is a SAMPLE - rename or delete it. It blanks the DISPLAY\n'
                        + 'of anything at depth 10 or deeper, leaving the prompt untouched: find_regex /.*/s with\n'
                        + 'the s flag so . spans newlines, an empty replace_string, destination.display true and\n'
                        + 'prompt false. A regex whose destination.prompt is true rewrites what the MODEL reads,\n'
                        + 'and must declare prompt_rewrite_intended: true to say it meant to.\n',
                },
                { path: dir + '/schema/statdata_schema.js', text: SAMPLE_SCHEMA },
                {
                    path: dir + '/schema/README.txt',
                    text: 'The ONE Zod registration script - schema/ holds exactly one file, whatever its name.\n'
                        + 'It runs in the page, so z (zod) and _ (lodash) are already global; import only\n'
                        + 'registerMvuSchema, and CALL it at the end or nothing is registered and MVU silently\n'
                        + 'validates nothing. Your schema describes the VALUE of stat_data directly, so every\n'
                        + 'root your game writes must appear in it - a field the schema does not name is STRIPPED\n'
                        + 'on the next write, with no error anywhere.\n\n'
                        + 'Leave GameLogicPlugin and $mvuhelper declared OPEN as shipped. They are the platform\n'
                        + 'roots: installed plugins name their own keys in GameLogicPlugin at install time, and\n'
                        + 'mvu-helper keeps its own parts in $mvuhelper. A closed shape strips them on the next\n'
                        + 'write. The pack validator refuses a closed one.\n',
                },
            ];
        },
    },
    {
        packType: 'statusmenu',
        label: 'StatusMenu Pack',
        folder: () => 'statusmenu',
        members({ id, name, description, builtWith }) {
            const dir = 'statusmenu';
            // The engine is TWO files with one owner each, the layout MVU Status Menu Builder exports:
            // layoutFormatters.cjs is the builder's (every layout export replaces it whole), and
            // statusMenuLogic.cjs is the developer's. engineOrder joins them into one script, so they
            // meet at ONE top-level name, LAYOUT_FORMATTERS.
            const layoutFormatters = [
                '// layoutFormatters.cjs — the formatters this menu\'s layout computes, EMPTY here because a',
                '// blank pack has no layout yet. MVU Status Menu Builder writes the real one from the layout\'s',
                '// cell formulas, and its "Refresh layout .zip" replaces this file whole, together with',
                '// layout/layout.json. Never write in it: a formatter written by hand goes in',
                '// statusMenuLogic.cjs, in HAND_FORMATTERS.',
                '//',
                '// It defines ONE name, LAYOUT_FORMATTERS, and loads before statusMenuLogic.cjs (pack.json',
                '// engineOrder). The two files run as one script: a name declared at the top level of both is',
                '// a SyntaxError that stops the whole engine loading.',
                'const LAYOUT_FORMATTERS = {};',
                '',
            ].join('\n');
            const engine = [
                '// ' + name + ' StatusMenu Engine',
                '//',
                '// The engine DECLARES its own identity and exports it. mvu-helper reads these off the',
                '// running module, and reads these same lines when checking a pack that is not loaded',
                '// yet — one source, two readers, so nothing can drift. They must be STRING LITERALS:',
                '// a computed value cannot be read back from source. Bump ENGINE_VERSION on every change;',
                '// it is reported and logged, never compared.',
                "const ENGINE_VERSION = 'v0.1.0';",
                '//',
                '// The display half: formatters read, actions write, nothing else. Formatters are',
                '// (stat, root, scopePath) => value and PURE — `stat` is the raw subtree at `scopePath`,',
                '// the path the menu scoped the cell to (a collection item\'s own path, `<list>.<key>`),',
                '// and `root` the whole stat_data. Actions are (args, root) => patches. The layout may only',
                '// name what is exported here; an export nothing names is reported as dead code.',
                '//',
                '// The formatters the layout\'s cells compute are NOT written here: they live in',
                '// layoutFormatters.cjs, which loads before this file (pack.json engineOrder), and arrive as',
                '// LAYOUT_FORMATTERS. This file is yours — no layout export ever replaces it.',
                '',
                '// Formatters written by hand, beside the layout\'s. A name the layout also computes is refused',
                '// when the engine loads: two definitions of one cell\'s formatter would leave one of them',
                '// silently dead.',
                'const HAND_FORMATTERS = {',
                '};',
                'for (const name of Object.keys(HAND_FORMATTERS)) {',
                '    if (Object.prototype.hasOwnProperty.call(LAYOUT_FORMATTERS, name)) {',
                '        throw new Error(\'formatter "\' + name + \'" is written by hand in statusMenuLogic.cjs AND computed by the layout (layoutFormatters.cjs) — rename the hand-written one\');',
                '    }',
                '}',
                '',
                'module.exports = {',
                '    ENGINE_VERSION,',
                '    formatters: { ...LAYOUT_FORMATTERS, ...HAND_FORMATTERS },',
                '    actions: {},',
                '};',
                '',
            ].join('\n');
            const layout = {
                kind: 'tabbed-grid',
                format: '1.0',
                tabs: [{
                    id: 'tab-1',
                    name: 'Status',
                    blocks: [{
                        id: 'blk-1',
                        title: 'Example',
                        width: 100,
                        mappedKey: '',
                        cards: [{ id: 'crd-1', type: 'StatRow', title: 'Example value', mappedKey: 'YourRoot.YourStat', width: 100 }],
                    }],
                }],
            };
            return [
                {
                    path: dir + '/pack.json',
                    text: packJsonText({ format: '1.0', packType: 'statusmenu', id, name, description, version: '0.1.0', builtWith, engineOrder: ['layoutFormatters.cjs', 'statusMenuLogic.cjs'] }),
                },
                { path: dir + '/engine/layoutFormatters.cjs', text: layoutFormatters },
                { path: dir + '/engine/statusMenuLogic.cjs', text: engine },
                { path: dir + '/layout/layout.json', text: JSON.stringify(layout, null, 2) + '\n' },
                {
                    path: dir + '/layout/README.txt',
                    text: 'WARNING - layout.json here is only a minimal EXAMPLE, shipped so the folder assembles.\n'
                        + 'ALWAYS create the real layout with MVU Status Menu Builder: design the menu graphically,\n'
                        + 'export its "Refresh layout .zip" and extract it into this statusmenu/ folder. It replaces\n'
                        + 'layout/layout.json AND engine/layoutFormatters.cjs - the formatters the layout\'s cell\n'
                        + 'formulas compute - and never touches engine/statusMenuLogic.cjs or pack.json. The two\n'
                        + 'always travel together: a layout.json dropped in alone names formatters nothing exports.\n'
                        + 'The builder owns the layout vocabulary - hand-editing this file means maintaining that\n'
                        + 'vocabulary by hand, and it WILL drift.\n',
                },
                // The pack-host shell — the CARD's menu body, without which a cold start renders
                // nothing. Byte format matches the builder bootstrap's shellArchiveMember.
                { path: dir + '/regex/StatusMenu.json', text: JSON.stringify(PLACEHOLDER_SHELL_REGEX, null, 2) + '\n' },
                {
                    path: dir + '/regex/README.txt',
                    text: 'StatusMenu.json here is a PLACEHOLDER, not a menu. It renders a notice saying so,\n'
                        + 'which is enough for the dev loop to apply this pack without error and for you to watch\n'
                        + 'the pipeline work end to end - and nothing more.\n'
                        + '\n'
                        + 'The REAL menu body comes from MVU Status Menu Builder: design the layout there, export\n'
                        + 'the StatusMenu Pack, and drop its regex/StatusMenu.json over this file. It carries the\n'
                        + 'same script_name, so it REPLACES this one rather than sitting beside it - two enabled\n'
                        + 'regexes matching the placeholder means first-in-list wins silently. Never hand-edit a\n'
                        + 'real one: it is generated, and the builder is where changes belong.\n',
                },
            ];
        },
    },
    {
        packType: 'plugin',
        label: 'GameLogic Plugin',
        folder: (id) => 'plugin-' + id,
        members({ id, name, description, builtWith }) {
            const dir = 'plugin-' + id;
            const engine = [
                '// ' + name + ' Plugin Engine',
                '//',
                '// The engine DECLARES its own identity and exports it. mvu-helper reads these off the',
                '// running module, and reads these same lines when checking a pack that is not loaded',
                '// yet — one source, two readers, so nothing can drift. They must be STRING LITERALS:',
                '// a computed value cannot be read back from source. Bump ENGINE_VERSION on every change;',
                '// it is reported and logged, never compared.',
                "const ENGINE_VERSION = 'v0.1.0';",
                '//',
                '// resolveRelay is the plugin\'s deterministic half: it runs once per reply, after the reply\'s last',
                '// write (after POST\'s block and the game engine\'s own relay, or after narrate\'s parse when POST',
                '// writes nothing) and returns JSON Patch ops built off ownPointer. The card\'s Zod judges every one;',
                '// keep to your own root unless the game exposes a path to you. ownState: this plugin\'s subtree · ops: what this turn applied ·',
                '// ownRoot/ownPointer: this plugin\'s root as dotted path / JSON Pointer · engine: the game',
                '// engine\'s identity { name, type, version, packId } — null fields when there is no game engine.',
                'module.exports = {',
                '    ENGINE_VERSION,',
                '    resolveRelay({ ownState, ops, exposes, engine, roster, ownRoot, ownPointer, pluginVersion, mid, swipe }) {',
                '        return { patches: [], log: [] };',
                '    },',
                '};',
                '',
            ].join('\n');
            return [
                {
                    path: dir + '/pack.json',
                    text: packJsonText({ format: '1.0', packType: 'plugin', id, name, description, version: '0.1.0', builtWith, engineOrder: ['relay-resolver.cjs'] }),
                },
                { path: dir + '/engine/relay-resolver.cjs', text: engine },
                ...exampleEntry(dir, 'narrate-window', 'narrate window',
                    'A DISABLED scaffold for the plugin\'s narrate duty — what the model is asked to observe.\n'
                    + 'The installer substitutes {OWN_ROOT} with this plugin\'s own state root at install\n'
                    + 'time, so this text can name it without knowing it. Write the duty, then set\n'
                    + '"enabled": true in the sidecar.\n\nYour state lives under {OWN_ROOT}.\n'),
                ...exampleEntry(dir, 'pre-window', 'pre window',
                    'A scaffold for a PRE window. Nothing routes it yet: a PRE entry reaches the PRE call the user\n'
                    + 'picks at install through the PRE call token at the start of its comment, written PRE_CALL in\n'
                    + 'curly braces (the plugin guide, "The three tokens"). Add it when you write the entry; while no\n'
                    + 'entry carries it, the install dialog asks for no PRE call. Keep the entry disabled: the call\n'
                    + 'reads it either way, and disabled keeps it out of the narrator\'s prompt.\n\n'
                    + 'A PRE call\'s output is injected onto the narrator\'s prompt, and it becomes a state writer\n'
                    + 'simply by emitting a <JSONPatch> block. APPEND, NEVER OPEN: ask for anything AFTER whatever the\n'
                    + 'host pack\'s own control file asked for - a card may check its PRE prose against a pattern, and\n'
                    + 'prose that fails is dropped whole, the host pack\'s own text included (patch blocks are kept).\n'
                    + 'Delete this pair if your plugin needs no PRE.\n\nYour root is {OWN_ROOT}.\n', 'selective'),
                ...exampleEntry(dir, 'record-window', 'record window',
                    'A scaffold for the POST record window. Nothing routes it yet: it reaches the POST call the user\n'
                    + 'picks at install through the POST call token at the start of its comment, written POST_CALL in\n'
                    + 'curly braces (the plugin guide, "The three tokens"). Add it when you write the entry; while no\n'
                    + 'entry carries it, the install dialog asks for no POST call. Keep the entry disabled: the call\n'
                    + 'reads it either way, and disabled keeps it out of the narrator\'s prompt.\n\n'
                    + 'Ask the model for ONE observation and let resolveRelay do the rest. USE YOUR OWN VERBS: keys you\n'
                    + 'CREATE take "add"; a fixed-arity tuple takes "replace" - "add" at an index INSERTS, the tuple\n'
                    + 'comes out one longer than its shape, and the schema throws the op away silently.\n\n'
                    + 'Record it under {OWN_ROOT}.\n', 'selective'),
                { path: dir + '/schema/plugin_root_schema.js', text: PLUGIN_ROOT_SCHEMA },
                {
                    path: dir + '/schema/README.txt',
                    text: "The ONE Zod registration script - schema/ holds exactly one file, whatever its name.\nEvery plugin ships one and it is REQUIRED (rule 7), because a plugin cannot know which\nkind of card it lands on. Where the card's schema came with its GameLogic Pack, install\nSKIPS this file, so carrying it costs that card nothing at all; where the card has a\nschema from anywhere else, install asks whether to replace it before writing anything.\n\nWhere the card has NO schema it is the only thing that works. Without it MVU falls back to\na schema derived from the shape of your data, and that one freezes every object to the keys\nit held at derivation - your drawer is created EMPTY, so it would accept nothing for the\nlife of the card.\n\nDeclare the platform roots, GameLogicPlugin and $mvuhelper, and NOTHING else. It runs in the page, so z (zod) and _ (lodash)\nare already global; import only registerMvuSchema, and CALL it at the end or nothing is\nregistered. Adding a GAME root here is what breaks the next card this plugin is installed on.\n",
                },
                {
                    path: dir + '/panel/README.txt',
                    text: 'panel/panel.json is this plugin\'s SIDE PANEL slot - the declarative half mvu-helper\n'
                        + 'renders in its own panel, the way layout.json is a StatusMenu Pack\'s. It is OPTIONAL and\n'
                        + 'deliberately absent here: a plugin with no panel simply has no panel.json, and this\n'
                        + 'folder assembles to nothing until you add one.\n\n'
                        + 'When you do: { "kind": "slot-list", "format": "1.0", ... } - the host reads kind and\n'
                        + 'format to choose a renderer and carries the rest verbatim. It is 100% DECLARATIVE;\n'
                        + 'customLogic anywhere inside is refused. Logic belongs in renderPanel in the engine.\n',
                },
            ];
        },
    },
];

// ── the build ────────────────────────────────────────────────────────────────

// Identity in, archive members out: { members, folder, errors }. Members are the full archive
// (folder-prefixed paths); strip the prefix to feed assembleArtifactSource — the UI and the tests
// both do exactly that, which is what keeps THE GUARANTEE (file header) one pipeline instead of two.
export function buildBlankArtifactMembers({ packType, id, name, description, builtWith } = {}) {
    const errors = [];
    const row = BLANK_ARTIFACT_TYPES.find((t) => t.packType === packType);
    if (!row) errors.push('unknown artifact type ' + JSON.stringify(packType) + ' — one of: ' + BLANK_ARTIFACT_TYPES.map((t) => t.packType).join(' · '));
    for (const [field, value] of [['id', id], ['name', name], ['description', description], ['builtWith', builtWith]]) {
        if (typeof value !== 'string' || !value.trim()) errors.push('"' + field + '" is required');
    }
    if (errors.length) return { members: [], folder: '', errors };
    const folder = row.folder(id);
    return { members: row.members({ id, name, description, builtWith }), folder, errors };
}

// The members with the workspace folder stripped — the artifact-root view assembleArtifactSource
// takes. Exported so the UI's pre-download validation and the test suite share one spelling.
export function artifactRootMembers(members, folder) {
    const prefix = folder + '/';
    return (Array.isArray(members) ? members : [])
        .filter((m) => m && String(m.path).startsWith(prefix))
        .map((m) => ({ path: String(m.path).slice(prefix.length), text: m.text }));
}
