# GameLogic Plugin: quick guide for AI assistants

You are an AI coding assistant in a clone of the `mvu-helper-template` workspace. The user asked you to build a GameLogic Plugin. Read this page whole before you write a file. Every path below is relative to the project folder (the one holding `CLAUDE.md`, `package.json` and `workspace/`). This page is the short form. The human-facing pages are linked at the end.

## 1. Hard rules

1. **A save under `workspace/` is a deploy.** The dev loop installs it on the open card within a second. Never save a half-written file. Build a new plugin folder outside `workspace/` and move it in when it is complete.
2. **MVU Helper is read-only.** You have no source for it and the dev server lives in npm's cache. If the dev loop refuses your plugin, your plugin is wrong.
3. **You own one drawer: `stat_data.GameLogicPlugin.<StateName>`.** The player picks `<StateName>` at install. Every write you make starts with that drawer: `ownPointer` in the engine, the path built from `{OWN_ROOT}` in entries. Never write a game root, never a game's report channel (ArtificKoi: `/Intent/...`).
4. **Never write when the drawer is missing.** MVU Helper creates it at install and on every chat load. A write into a missing drawer lands anyway and rebuilds a root nobody registered. Log the absence and write nothing.
5. **Never guess the game.** Identify it only by `ctx.engine.name` / `MvuHelper.engineInfo().name`. Find its data only through interfaces you declared in `requires` / `optionalUses` (`ctx.exposes`, `MvuHelper.exposes()`). Read any field beyond what an interface promises only behind `engine.name === '<Name>'`.
6. **Every degrade path is written.** `engine.name === null` (no game), `exposes` = `{}`, an optional interface missing, and "declared but absent from stat_data" each get a branch that returns. A resolver that throws loses all its patches.
7. **Dice are dealt in entries, from your own pool.** `MvuHelper.rollPool(n, null, 'YOURPOOL')`. The resolver only checks them in `ctx.dicePools` and never rolls.
8. **One EJS scope per pass, shared with the game.** Prefix every top-level `const`/`let` in an entry with a prefix unique to your plugin, or declare inside a block. Never `setvar`.
9. **Exact work goes in `resolveRelay`.** A model only observes, one simple judgment at a time. Never ask a model to compute, count or decide a number.
10. **Write like a guest** (section 9). Your prompt text shares a system block with the game's.
11. **No `console.*`.** Log with `globalThis.MvuHelper.log` (`.child('<id>')` in entries). In engine code, always write `globalThis.MvuHelper`: a bare `MvuHelper` throws `MvuHelper is not defined` inside the Worker.
12. **No fallback or migration logic without asking the user** (template `CLAUDE.md`).
13. **Run `npm test` before you call anything done.**

## 2. What a plugin is and is not

- It adds one feature (weather, a wardrobe, a journal) to any MVU card without editing the game. It can run on a card with no GameLogic Pack at all.
- It owns only its drawer. It can read all of `stat_data`. Technically it can write any path the card's Zod allows. It must not.
- **Standalone**: `requires` empty (or absent). Installs on any card. **Game-bound**: `requires` lists interfaces. Install is refused, by name, on a card whose game does not expose all of them.
- It has no `init` (no starting state), no `regex`, no `exposes`, no `state`. A file with any of these is refused.
- Its engine runs in MVU Helper's Worker sandbox: JavaScript plus `console`, `crypto`, `structuredClone`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `globalThis.MvuHelper` (`engineInfo()`, `log`, `settings`, `messages`, reached only through `globalThis`). No network, no DOM, no timers, no `import()`, no `require`. It cannot call the game engine.

## 3. The folder

```
workspace/plugin-<id>/
├── pack.json                     # identity, requires / optionalUses, engineOrder
├── schema/plugin_root_schema.js  # REQUIRED, exactly one file
├── entries/<name>.txt            # entry text (EJS allowed)
├── entries/<name>.json           # entry fields, same base name as the .txt
├── engine/<file>.cjs             # optional, every file listed in engineOrder
└── panel/panel.json              # optional side panel slot, the only file allowed in panel/
```

- Only `pack.json` may sit at the folder root. Allowed directories for a plugin: `engine/`, `entries/`, `schema/`, `panel/`. `README.txt` / `README.md` and dot files are ignored.
- Every `.txt` in `entries/` needs its `.json` and the reverse. Subfolders are fine.
- A sidecar must not carry `content`, `uid` or `display_index`, and never a boolean `constant` / `selective` / `vectorized`. Write `"type": "constant"` or `"type": "selective"`.
- Engine files are concatenated in `engineOrder` into ONE script. A top-level name in one file is visible in later files, the same top-level name in 2 files breaks the whole engine. A file missing from `engineOrder`, or a name in it with no file, is an error.

### pack.json

```json
{
  "format": "1.0",
  "packType": "plugin",
  "id": "wardrobe-log",
  "name": "Wardrobe Log",
  "description": "Records what each character wears and reminds the narrator.",
  "version": "0.1.0",
  "builtWith": "hand-authored",
  "optionalUses": ["cast@1"],
  "engineOrder": ["relay-resolver.cjs"]
}
```

| Key | Rule |
| --- | --- |
| `format` | `"1.0"` |
| `packType` | `"plugin"` |
| `id` | kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`), unique in the library, never `registry` |
| `name`, `description` | required, non-empty |
| `version` | `M.m` or `M.m.r`, numbers only. Upgrade compares it |
| `requires` | array of interface names. Unmatched = install refused |
| `optionalUses` | array of interface names. Unmatched = installs, runs without |
| `engineOrder` | source-only key, consumed by the assembler. Required when `engine/` has files |

An interface name matches `^[a-z][a-z0-9-]*@\d+$`, like `cast@1`. The published set is on [Exposes](../gamelogic_engine/exposes.md#the-interfaces): `cast@1`, `player@1`, `location@1`, `landmarks@1`, `chronicle@1`, `clock@1` (`locale@1` is proposed, nobody publishes it). Example: ArtificKoi's `pack.json` maps `"cast@1": "Classmate"` and `"clock@1": "World"`. Unknown top-level keys only warn, and are not installed.

### The schema file

Copy `workspace/plugin-standalone-probe/schema/plugin_root_schema.js` byte for byte. Its one line of substance is `GameLogicPlugin: z.record(z.string(), z.any()).prefault({})` inside `z.looseObject({...})`. Never name a game root in it, never close the root, never wrap the root in `.prefault`. Install skips it on a card whose GameLogic Pack owns the schema, writes it on a card with none, and asks the player on a card with a foreign schema. See [The schema](../gamelogic_plugin/writing.md#the-schema).

## 4. Entries: 3 windows, 3 tokens

| Window | Comment | Sidecar | Who reads it | Cost |
| --- | --- | --- | --- | --- |
| narrate | no call token, no `[...]` at all | `"type": "constant"`, `"enabled": true` | the narrator | free |
| PRE | contains `{PRE_CALL}` | `"type": "selective"`, `"keys": []` | the PRE model. Its OUTPUT is prepended to the narrator's prompt | one call, or 0 when sharing the game's |
| POST | contains `{POST_CALL}` | `"type": "selective"`, `"keys": []` | the POST model, after the reply (the finished reply is its input) | one call, or 0 when sharing |

| Token | Installed as | Where it works |
| --- | --- | --- |
| `{PRE_CALL}` | `[<PRE call the player picked>]` | entry `comment` |
| `{POST_CALL}` | `[<POST call the player picked>]` | entry `comment` |
| `{OWN_ROOT}` | `GameLogicPlugin.<StateName>` (dotted) | entry `comment` and `content` only. NOT in the engine (use `ctx.ownRoot`) and NOT in `panel.json` (bare paths already read your drawer) |

- Using a token is how you declare the need. The install dialog asks for a PRE / POST call only when some entry uses that token, plus the **State root** (letters, digits, `_`, starting with a letter).
- Routing reads the comment, but token detection reads comment AND content. A `{POST_CALL}` written anywhere in a `.txt`, even inside an EJS comment, makes install ask for a POST call.
- Installed comment: `[GameLogicPlugin:<id>] <your comment with tokens filled>`. Never write `[GameLogicPlugin:`, `[GameLogicPack:`, `[StatusMenuPack:` or `[MVU_` yourself.
- Any other `{UPPERCASE}` token is warned and reaches the model verbatim. `{{user}}` is untouched.
- A routed entry that is enabled and `constant` (or enabled with keys) is refused (rule 15): it would also hit the narrator.
- PRE writes state by emitting `<JSONPatch>[...]</JSONPatch>`, applied before the narrator runs. POST writes by emitting `<UpdateVariable><JSONPatch>[...]</JSONPatch></UpdateVariable>`.
- A POST block is not guaranteed every reply (shared output, provider cuts). Design state that survives a skipped reply.

### EJS skeleton (any window)

```ejs
<%_
const WL_ROOT = '{OWN_ROOT}';                              // "GameLogicPlugin.<StateName>"
const WL_PATH = '/' + WL_ROOT.split('.').join('/');        // JSON Pointer for printed ops
let WL_TEXT = '';
try {
    const helper = globalThis.MvuHelper || {};
    const engine = (helper.engineInfo && helper.engineInfo()) || {};   // { name, type, version, packId, exposes }
    const exposes = (helper.exposes && helper.exposes()) || {};        // read ONLY interfaces you declared
    let mine = getvar('stat_data') || {};
    for (const seg of WL_ROOT.split('.')) mine = (mine && typeof mine === 'object') ? mine[seg] : undefined;
    if (mine && typeof mine === 'object') {
        // compute here; build any op block as a STRING, e.g.
        // WL_TEXT = '<UpdateVariable>\n<JSONPatch>\n' + JSON.stringify(ops) + '\n</JSONPatch>\n</UpdateVariable>';
    }
} catch (e) {
    globalThis.MvuHelper.log.child('wardrobe-log').warn('entry failed:', e);
}
_%>
<%- WL_TEXT %>
```

- Branch in code, not in template text. Public docs say: keep `if` gates flat and put no literal `{` / `}` in template text inside a gate. Building the block as a string and printing it with `<%- %>` meets both.
- `<%= %>` prints escaped, `<%- %>` prints raw (JSON needs raw).
- `'{{mvuhelperEngineName}}'` inside `<% %>` is always the raw token, because EJS runs before macros. Branch on `MvuHelper.engineInfo().name`.
- Hand the model finished ops. The only thing a model may fill in is one observation (a placeholder word it replaces).

## 5. The engine: `resolveRelay(ctx)`

**When it runs.** Once per reply, after the reply's last write, in the same reply, with or without a game. POST wrote a block: right after that block applies (and after the game's `resolvePostRelay` when the game exports one). POST wrote nothing or no POST call ran: after the reply's own update (the game's RES1 included) is done. MVU Helper keeps the once-per-reply guard (per generation epoch and `mid:swipe`). A regenerate is a new reply. A stopped reply runs nothing. Writes that would land after the next generation started are dropped.

| `ctx` field | Value |
| --- | --- |
| `ownState` | copy of your drawer. **`{}` when the drawer is missing, never `null`.** Check the drawer through `snapshot` |
| `snapshot` | copy of all `stat_data` |
| `ops` | always an array: `[{ path, old, new, by }]` applied this reply, DOTTED paths. Refused ops never appear. Several writes to one path show as one. Arrays show whole |
| `dice` | every die dealt this generation, flat, or `null` |
| `dicePools` | `[{ pool, sides, dice }]` and seeded `[{ hash, sides, dice }]`, or `null`. The unnamed pool appears as `pool: 'default'` |
| `exposes` | YOUR declared interfaces matched to game paths, `{ "cast@1": "Classmate" }`, or `{}` |
| `engine` | `{ name, type, version, packId }`, every field `null` with no game engine |
| `roster` | every installed plugin: `{ "<id>": "GameLogicPlugin.<StateName>" }` |
| `ownRoot` / `ownPointer` | `GameLogicPlugin.<StateName>` / `/GameLogicPlugin/<StateName>` |
| `pluginVersion`, `mid`, `swipe` | installed version, message index, swipe index |

`ops[].by`: `message` (the reply's block), `pre-sim` (a PRE patch), `post` (POST's block), `plugin:<id>` (a resolver, your own earlier writes included), `statusmenu:<id>`, `host`.

**Return** `{ patches, log }`. `patches`: JSON Patch ops, verbs `add` / `replace` / `remove` only, path must start with `/`. Only `op`, `path`, `value` are forwarded. A malformed op or a non-JSON value (cycle, Map, Date object) is dropped alone. The rest go to `Mvu.parseMessage` in one `<UpdateVariable>` block and the card's Zod judges each, so an op can be refused. `log`: strings MVU Helper prints as `[mvu-helper] [gamelogic-plugin] "<id>": ...` (Pipeline debug domain). A throw drops your patches only, the reply and other plugins go on.

```js
const ENGINE_VERSION = 'v0.1.0';   // string literal at line start, exported. Refused without it. Bump on every change

const readPath = (root, dotted) => String(dotted || '').split('.').filter(Boolean)
    .reduce((node, key) => ((node && typeof node === 'object') ? node[key] : undefined), root);
const unwrap = (v) => (Array.isArray(v) ? v[0] : v);   // ONLY on values an interface promises (Name, Label, Date...)

module.exports = {
    ENGINE_VERSION,
    resolveRelay({ ownState, snapshot, ops, dicePools, exposes, engine, ownRoot, ownPointer, mid, swipe }) {
        const drawer = readPath(snapshot, ownRoot);
        if (!drawer || typeof drawer !== 'object') return { patches: [], log: ['drawer ' + ownRoot + ' missing, writing nothing'] };

        const said = ops.find((o) => o.path === ownRoot + '.Observed');   // proof the POST write APPLIED
        const castPath = exposes['cast@1'];                               // undefined = degrade
        const cast = castPath ? readPath(snapshot, castPath) : undefined;
        const ids = (cast && typeof cast === 'object')
            ? Object.keys(cast).filter((k) => !k.startsWith('$') && k !== 'template' && cast[k] && typeof cast[k] === 'object')
            : [];
        const pool = (dicePools || []).find((p) => p.pool === 'WARDROBE' && p.sides === 20);   // own pool only

        const patches = [
            { op: 'add', path: ownPointer + '/LastAt', value: mid + ':' + swipe },
            { op: 'add', path: ownPointer + '/CastCount', value: ids.length },
        ];
        return { patches, log: ['observed=' + (said ? 'yes' : 'none') + ' engine=' + (engine.name || 'none') + ' die=' + (pool ? pool.dice[0] : 'none')] };
    },

    // optional: computes the side panel slot; panel/panel.json must still exist (it is the fallback)
    // renderPanel({ ownState, snapshot, engine, exposes }) { return { title, tabs: [...] }; },
};
```

Write shapes that land on Zod and no-Zod cards alike: `add` for keys you create in your drawer, `replace` on a `[value, "Label"]` slot, one object-valued op per child, and create a missing parent in the same patch (`add <own>/Characters {}` only when previous state lacks it, because `add` over an existing container wipes it). See [Write shapes](../gamelogic_plugin/writing.md#write-shapes-that-land-on-both).

### panel/panel.json

`{ "kind": "slot-list", "format": "1.0", "title": "...", "tabs": [ { "id", "name", "blocks": [...] } ] }`. Block types `fields` and `collection`. A bare path reads YOUR drawer. `{cast@1}.X` reads through a declared interface. `$.World.Time` is a raw read from the top of `stat_data`. Colors are hex only. Bind your own drawer for everything that must show on any card. Full format: [How the side panel works](../side_panel/technical.md). Working example: `workspace/plugin-standalone-probe/panel/panel.json`.

## 6. Dice

```js
const d20  = (globalThis.MvuHelper.rollPool(1, null, 'WARDROBE') || [])[0];   // count, hash, pool name
const two6 = globalThis.MvuHelper.rollPool(2, null, 'WARDROBE', 6);         // 4th arg = faces, default 20
```

- Count 1 to 20, faces 2 to 1000. Anything else deals `[]` and logs which argument was wrong.
- A pool deals once per generation. Every prompt build in that generation reads the same dice, and the resolver gets them in `ctx.dicePools`.
- A pool is a name AND a face count. A non-null `hash` deals swipe-stable seeded dice instead.
- No pool name means the unnamed pool `default`, which the game's own checks use. ArtificKoi deals `default` (8 d20) and `PRE`. Never use either.
- In the resolver, look up your die in `dicePools` by `pool` and `sides`. The flat `dice` list lets a game's d20 vouch for yours. `null` means nothing was dealt, which is never a reason to roll.

## 7. Reading the game

| You are in | Which game | Where its data is |
| --- | --- | --- |
| `resolveRelay` / `renderPanel` | `ctx.engine.name` | `ctx.exposes['<iface>']`, then walk `snapshot` |
| EJS | `MvuHelper.engineInfo().name` | `MvuHelper.exposes()['<iface>']` (full map, read only what you declared) |
| plain entry text | `{{mvuhelperEngineName}}` | none |

- Match on `name`, never `type`. `version` is information, never a gate.
- MVU Helper never checks what sits at an exposed path. Handle `undefined`.
- A collection can hold MVU bookkeeping keys: skip keys starting with `$`, and `template`.
- Example: on ArtificKoi, `engine.name` is `'School'`, heroines are keyed by `Classmate.<Key>`, and most values are `[value, label]` pairs. That is ArtificKoi's vocabulary, so read it only behind `engine.name === 'School'`. See [A real host: ArtificKoi](../gamelogic_plugin/artifickoi.md).

## 8. Which window for what

- Computable from state: narrate entry, free.
- Needs a model to read the finished prose: POST entry that transcribes ONE observation, and `resolveRelay` turns it into structure. Example: `plugin-standalone-probe` (POST writes one string `PostSaid`, the resolver splits it into `Characters.<Name>`).
- Needs a model judgment before the prose: PRE entry. Give a PRE entry that asks for prose its own call: a game's PRE `outputRegex` drops the whole prose part when your line breaks its opening.
- A plugin meant for any game keeps to ONE model window. A report-only narrate entry beside a POST recorder counts as one.

## 9. Write like a guest

Every entry routed to a call is joined into one system block with the game's instructions. The model copies whatever style is on the board.

- Keep example ops few. A long block can take over the call's whole answer.
- Match the game's verbs on shapes you share. Say in one line that your block's verbs are yours.
- Print only paths inside your drawer. Never print a game path, even as a warning example.
- Don't write "copy this exactly". The model cannot scope it to your block.
- Append after the game's output. Never ask for anything that must come first.
- Never contradict the game's rules or setting. Keep narrate text short: its tokens are spent on every reply of every player.
- Shared calls are the default. When the game's contract is strict, the player can bind your entry to a call of its own.

## 10. Workflow

1. **Check the rig.** MCP `list_pages` shows the SillyTavern tab (not `about:blank`). Ask the user to confirm `npm run dev` runs and the Artifact dev loop pill reads **Connected**. Through MCP `evaluate_script`: `() => MvuHelper.engineInfo()` and `() => MvuHelper.exposes()` tell you the game and its interfaces.
2. **Design, then confirm with the user.** Feature, window(s), drawer keys, standalone or game-bound, interfaces, pool name, what the resolver computes. A design question goes to the user before you build.
3. **Scaffold outside `workspace/`.** Copy the closest probe (`plugin-standalone-probe` for narrate + POST + resolver + panel, `plugin-lane-probe` for PRE and dice) to `plugin-<id>/` at the project root. Rename: `pack.json` `id` / `name` / `description` / `version`, the EJS prefix (`SP_` / `LP_`), the pool name (`LANEPROBE`), and the probe ids hardcoded in its resolver. Delete what you don't need (probe echo tests, `Relay*` diagnostics, the seeded deal). Keep the schema file. Or start from Development tab > Add New Blank Packs > GameLogic Plugin.
4. **Move it into `workspace/` in one step.** Verify: `npm test` passes. The pill shows **Setup needed** naming your id (first time on this card) or **Not applied** with the reason. With verbosity at lifecycle, the console prints `[mvu-helper] [artifact-dev-loop] plugin "<id>" v<version> ...` per apply.
5. **First install, by the user** (or by you only when they say so): GameLogic Packs tab > the plugin's library row > Install to this card > State root + one call per token used. If the loop asked Install all / Not here, that answer is the user's. On another author's game, Not here keeps the template's blank GameLogic Pack off the card.
6. **Verify the install.** `async () => { const i = await MvuHelper.packInfo(); return { plugins: i.types.plugin.installed, disagreements: i.disagreements }; }` lists your id with `detail.stateName` and `detail.boundCalls`, with `disagreements` empty. The plugin's On this card row shows the **Installed** pill, `GameLogicPlugin.<StateName>`, `standalone` or `game-bound` with the interfaces it needs, and its Bound calls. **Pieces missing**, **No library copy** or **Drift** mean the install is not clean.
7. **Turn on logging.** Ask the user to switch on the Pipeline debug domain (Main tab > Debug). Smallllm dumps each call's full system block.
8. **Play one reply** (the user, or you one turn at a time when allowed). Then verify each piece:
   - routed entries: `[mvu-helper] [small-llm] [<call>] routed lorebook entries (N):` lists yours,
   - resolver receipt: `[mvu-helper] [logic-engine] [RES2] plugin <mid:swipe>: "<id>" landed N/M op(s)`,
   - your lines: `[mvu-helper] [gamelogic-plugin] "<id>": ...` and `[mvu-helper] [engine:plugin:<id>] ...`,
   - the drawer: `async () => { const c = SillyTavern.getContext().chat; const d = await Mvu.getMvuData({ type: 'message', message_id: c.length - 1 }); return d.stat_data.GameLogicPlugin; }`.
9. **Iterate.** Edit, save, the loop re-applies (no reinstall), play, read. Bump `ENGINE_VERSION` on every engine change.
10. **Prove the degrade paths.** A standalone plugin: also run it on a card with no GameLogic Pack (`engine.name` null, `exposes` `{}`). An optional interface: confirm its missing branch writes what you designed.

## 11. Symptom > cause > fix

| Symptom | Cause | Fix |
| --- | --- | --- |
| Pill **Setup needed**, `"<id>" is waiting on a one-time setup step` | never installed on this card | step 5, one manual install |
| Pill **Not applied** naming your id | assembly or validation error (rule number in the reason) | fix the file the reason names |
| `rule 15: ... is routed to a call, but SillyTavern would also put it in the narrator's prompt` | routed entry enabled + `constant` or keyed | `"type": "selective"`, `"keys": []` |
| `npm test`: `COLLISIONS ... [narrate] X_NAME -> a.txt, b.txt` | 2 entries in one pass declare one top-level name (often a copied probe prefix) | rename the prefix, or move the declaration into a block |
| Model answers from raw `<%_` text, or a branch that never ran | EJS compile failure: same-name declaration with the game's entries, or syntax | prefix all top-level names, `npm test` |
| Narrate entry never shows | `selective` with no keys, or a `[...]` in its comment routes it to a call | `"type": "constant"`, no brackets |
| No PRE / POST call asked at install | no `{PRE_CALL}` / `{POST_CALL}` token in any comment | add the token |
| Install refused naming an interface | `requires` not exposed by this game | move it to `optionalUses` and write the degrade path |
| No `[RES2] plugin` line at all | Pipeline domain off, plugin not installed on this card, no `resolveRelay` export, or the engine failed to load | check each, read the load error |
| `[RES2] plugin ... resolver threw` | exception in your resolver | guard `undefined` reads, especially exposed paths |
| `relay "<id>": dropped op #N ...` | malformed op or non-JSON value | `add`/`replace`/`remove`, `/` path, plain JSON value |
| `landed N/M op(s) (K refused)` + a warning per op | the card's Zod refused: no open `GameLogicPlugin`, path outside drawer, `add` on a pair slot | fix the path or verb. Row says the card has no schema: Repair |
| `Cannot assign into path '...' ... (json_patch)` | no-Zod card, deep `add` through a missing parent | create the parent in the same patch |
| `[POST] N/M op path(s) ABSENT after the apply` | POST ops refused (yours or the game's) | your block taught a wrong verb or path: section 9 |
| Game's PRE text vanishes: `the output FAILED the card's output-check regex` | your PRE line made the output open wrong on a strict shared call | own PRE call, or append only after the game's output |
| Your die is the game's die | `rollPool` with no pool name or the game's pool name | own pool name |
| Count steps twice in one reply | a POST entry counting with no guard (POST can run twice) | count in `resolveRelay`, or guard on your own pool's seed |
| `ownState` is `{}` and you wrote anyway | drawer missing, `ownState` never null | check `snapshot` at `ownRoot` first |
| **Drift** pill | bound call renamed / deleted, or an exposed interface disappeared | Rebind PRE/POST call on the row. Interface drift has no rebind |
| `{OWN_ROOT}` text reaches the prompt or engine | token typo (rule 9 warning) or used in engine code | fix the spelling, use `ctx.ownRoot` in the engine |
| Panel rows show `·` | key not written yet, wrong bare path, or `{iface}` not declared | write the key, declare the interface |

## 12. Done checklist

Plugin:
- [ ] `pack.json`: `packType` `plugin`, kebab-case `id` not used by another workspace folder, numeric `version`, `engineOrder` matching `engine/`.
- [ ] Schema file is the probe's, unchanged.
- [ ] Each window's need is declared only by its token. Routed entries are `selective` with no keys. The narrate entry is `constant`.
- [ ] Every top-level EJS name carries your prefix. No `setvar`. No macro read inside `<% %>`.
- [ ] Every write is inside your drawer, and nothing is written when the drawer is missing.
- [ ] Ops use the shapes that land on both card kinds.
- [ ] Dice come from your own named pool, dealt in an entry. The resolver only checks `dicePools`.
- [ ] Prompt text follows section 9.
- [ ] A reply where POST wrote nothing is recorded, not skipped.
- [ ] `npm test` passes, the row reads **Installed**, the RES2 receipt shows `landed N/N`, and the drawer holds what you designed.

Any game (from [Running on any game](../gamelogic_plugin/any_game.md)):
- [ ] Every game word in your resolver came out of `exposes`, or sits behind an `engine.name === '...'` check.
- [ ] `engine.name === null` is handled as "unknown game", not as an error.
- [ ] Every `optionalUses` interface has a written path that returns instead of throwing.
- [ ] "Declared but missing" is handled separately from "not declared".
- [ ] Every promised value goes through the unwrap line. A field beyond the promise is read from the game's own docs, behind its `engine.name`.
- [ ] Every collection is walked without MVU's own keys: anything starting with `$`, and `template`.
- [ ] Branching code uses `globalThis.MvuHelper`, never a macro.
- [ ] The version is recorded, not checked, unless you name the one change you work around.
- [ ] Standalone: no `requires`, and the panel still says something useful with nothing exposed.

## The full pages

[What is GameLogic Plugin](../gamelogic_plugin/README.md) · [How it works](../gamelogic_plugin/technical.md) · [The plugin file](../gamelogic_plugin/file.md) · [Build, install and uninstall](../gamelogic_plugin/install.md) · [Entries and the 3 windows](../gamelogic_plugin/entries.md) · [Writing into stat_data](../gamelogic_plugin/writing.md) · [The plugin engine](../gamelogic_plugin/engine.md) · [Running on any game](../gamelogic_plugin/any_game.md) · [A real host: ArtificKoi](../gamelogic_plugin/artifickoi.md) · [Exposes](../gamelogic_engine/exposes.md) · [Same reply protection](../gamelogic_engine/same_reply.md) · [Side panel format](../side_panel/technical.md) · [Macros and API](../macros_api/technical.md) · [Development Environment](../dev_env/README.md)

[Back to QuickStart Guide](../quickstart.md)
