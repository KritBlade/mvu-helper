# GameLogic Engine: quick guide for AI assistants

You are an AI coding assistant in a clone of the `mvu-helper-template` workspace. The user asked you to turn their character card into a game: a GameLogic Pack with a GameLogic Engine. Read this page whole before you write a file. Every path below is relative to the project folder (the one holding `CLAUDE.md`, `package.json` and `workspace/`). Your pack is `workspace/gamelogic/`. ArtificKoi (School v4, the first game built on MVU Helper) appears as a real example, never as a rule. The human-facing pages are linked at the end.

## 1. Hard rules

1. **A save under `workspace/` is a deploy.** The dev loop installs it on the open card within a second. Never save a half-written file. Write each file whole.
2. **MVU Helper is read-only.** You have no source for it and the dev server lives in npm's cache. If the dev loop refuses your pack, your pack is wrong.
3. **The narrator observes, the engine decides.** The narrator reports what its prose did on `/Intent/<channel>` paths, one simple judgment per channel. It never writes a stat, a total, a verdict or an outcome. The engine (RES) does every calculation. A low-end model must be able to do every narrator duty.
4. **Values, never increments.** Every op a model emits is `replace` with a value. A change the engine must apply goes in as a report (`/Intent/money/0` = `"-480"`), never as "add 3 to Affection".
5. **Consume and clear.** After the engine resolves a channel, it sets it back to `""` (label kept) and stamps the reply (`Intent.resolvedFor = "<mid>:<swipe>"`).
6. **Every path anyone writes is declared in the Zod schema AND seeded in `[InitVar]`.** An undeclared field is stripped on the next write, with no error anywhere.
7. **Engine identity is 3 string literals**, each on its own line, exported. Inside the engine the host API is `globalThis.MvuHelper`. A bare `MvuHelper` throws `MvuHelper is not defined`.
8. **One EJS scope per pass.** Prefix every top-level `let`/`const` in an entry, or declare inside a block. Never `setvar`. Always `await LogicEngine.<fn>(...)`.
9. **Dice are dealt in EJS with `MvuHelper.rollPool`.** The engine only checks them in `ctx.dice` / `ctx.dicePools`. No `Math.random` for anything the prose shows.
10. **No `console.*`.** Log with `globalThis.MvuHelper.log.child('<stage>')` in the engine, `MvuHelper.log.child('EJS')` in entries.
11. **No fallback or migration logic without asking the user** (template `CLAUDE.md`).
12. **Run `npm test` before you call anything done.**

## 2. The workspace

| Path | What it is |
| --- | --- |
| `workspace/gamelogic/pack.json` | identity and `engineOrder` (section 6) |
| `workspace/gamelogic/engine/gameLogic.cjs` | the engine. Blank: exports `resolveTurn` returning `applied: false` |
| `workspace/gamelogic/engine/README.txt` | how to wire event packs (`eventpack.cjs` downloads from MVU Helper's [`eventpack_lib/`](https://github.com/KritBlade/mvu-helper/tree/main/eventpack_lib)). Ignored by the assembler |
| `workspace/gamelogic/entries/` | prompt entries, `<name>.txt` + `<name>.json`, any subfolders. Ships one disabled `example-window` |
| `workspace/gamelogic/schema/statdata_schema.js` | the Zod schema, exactly one file. Ships a placeholder `Cast` root |
| `workspace/gamelogic/regex/` | one regex per `.json`. Ships `HideFarFloor.json` (a sample) |
| `tools/` | the checks `npm test` runs. `tools/entry_routes.cjs` holds `GROUP_TAGS` |
| `workspace/plugin-*`, `statusmenu/`, `evenpack-test-series/` | samples of the other pack types. Leave them alone |

Only `pack.json` and the folders `engine/`, `entries/`, `schema/`, `regex/`, `panel/` may sit in `gamelogic/`. Dot files and `README.txt` / `README.md` are ignored anywhere.

## 3. The 3 starting inputs

Create these 3 before any engine logic. The blank pack ships none of them. The layout below copies ArtificKoi's `entries/config/`.

### 3.1 The `[InitVar]` seed: the starting `stat_data`

- **Files:** `entries/config/initvar_mvu_init.txt` (content) + `entries/config/initvar_mvu_init.json` (sidecar).
- **Content:** one JSON object that IS the value of `stat_data`. No `stat_data` key around it, no wrapper tag.
- **Shape:** every scalar stat is a `[value, "Label"]` pair. Containers (a cast keyed by id, a record list) are plain objects. Seed every `/Intent` channel empty (`["", "Label"]`, booleans `[false, "Label"]`), plus the stamp, plus `"GameLogicPlugin": {}`.

```json
{
  "World": { "Date": ["2026-04-08", "Date"], "Time": ["08:00", "Time"], "Location": ["Home", "Location"] },
  "Player": { "Name": ["", "Name"], "Money": [3000, "Money"], "Int": [10, "INT"], "Str": [10, "STR"] },
  "Cast": {},
  "Intent": { "training": ["", "Training"], "money": ["", "Money Change"], "resolvedFor": ["", "Resolved For"] },
  "GameLogicPlugin": {}
}
```

```json
{ "comment": "[InitVar] MVU Init", "type": "selective", "keys": [], "position": "before_character_definition", "order": 100, "enabled": false }
```

**How it reaches the card.** The dev loop writes it into the card's lorebook as `[GameLogicPack:<id>] [InitVar] MVU Init`. MVU builds a NEW chat's `stat_data` from it. MVU Helper re-applies it on every chat load and every install (each dev-loop apply included), create-only at any depth: a missing key is added, an existing value is never overwritten. So a new field reaches running chats by itself. A changed starting value reaches old saves only when `state` pushes it, once per save per `state.version` bump: `forceFromInitVar` pushes `[InitVar]`'s own value at a path (a definitions table such as `EventPack.triggers`, row by row, deleting nothing), and `force` writes a literal value ([State corrections](../gamelogic_engine/state.md)). If the user's card already carries its own `[InitVar]`, start from its content and ask the user before you remove or disable the card's copy.

### 3.2 The `[Initmvuhelper]` card config

- **Files:** `entries/config/initmvuhelper_mvu_helper_card_config.txt` + `.json`. Sidecar as above with `"comment": "[Initmvuhelper] mvu-helper card config"`, `"order": 101`.
- **Content:** `#` comment lines are allowed only OUTSIDE the wrapper. Inside `<initmvuhelper>...</initmvuhelper>` is pure JSON.

```
# PRE classifies the player's line, POST records what the prose showed.
<initmvuhelper>
{
  "version": 1,
  "extraLlmCalls": {
    "enabled": true, "parallel": true, "timeoutSec": 60,
    "groups": [ { "tag": "llmshare", "members": ["PRE", "POST"] } ],
    "calls": [
      { "name": "PRE", "phase": "pre", "enabled": true },
      { "name": "POST", "phase": "post", "enabled": true }
    ]
  }
}
</initmvuhelper>
```

| Top-level key | Holds |
| --- | --- |
| `version` | config schema version, `1` |
| `extraLlmCalls` | `enabled`, `parallel`, `timeoutSec`, `groups[{ tag, members }]`, `calls[{ name, phase: "pre"\|"post", enabled, maxTokens?, temperature?, inputRegex?, outputRegex? }]` ([Set up the calls](../extra_llm_calls/calls.md)) |
| `statBox` | the per-reply "stats that moved" box ([The statBox section](../stat_box/technical.md#the-statbox-section)) |
| `imagegen` | `intimacyLatchPath`, `maincharRegistryKey` and the `<pic>` contract fields |
| `roster` | `route`, `charCollection`, `presenceField` |
| `logicEngine` | `{ "enabled": true }` |

ArtificKoi ships `extraLlmCalls`, `imagegen` and `statBox`. A key not in this table is reported as unknown and ignored. A call's connection profile never travels (a `profileId` is dropped and reported): the user picks each call's Connection in the Extra LLM Calls tab, and a call with none does not run. MVU Helper imports this entry on chat load when its content changed since the last import. After a dev-loop save, reopen the chat or use Main tab > Card config > Re-import. The first lorebook entry whose comment contains `[Initmvuhelper]` is the one read, so keep exactly one. Never use Export to card while the pack carries it: export overwrites that first match, and the next dev-loop apply puts the pack's text back.

### 3.3 The schema syntax: Zod for MVU, a vocabulary for the models

**(a) `schema/statdata_schema.js`** mirrors the seed, key for key. Keep the template's helpers and root shape:

```js
import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';
const strEmpty = z.string().prefault('');
const num0 = z.coerce.number().prefault(0);
const labeledStr = z.tuple([strEmpty, strEmpty]).prefault(['', '']);
const labeledNum = z.tuple([num0, strEmpty]).prefault([0, '']);
const playerSchema = z.looseObject({ Name: labeledStr, Money: labeledNum, Int: labeledNum, Str: labeledNum }).prefault({});
const intentSchema = z.looseObject({ training: labeledStr, money: labeledStr, resolvedFor: labeledStr }).prefault({});
const StatDataSchema = z.looseObject({
  World: z.looseObject({ Date: labeledStr, Time: labeledStr, Location: labeledStr }).prefault({}),
  Player: playerSchema,
  Cast: z.record(z.string(), z.looseObject({ Name: labeledStr }).prefault({})).prefault({}),
  Intent: intentSchema,
  GameLogicPlugin: z.record(z.string(), z.any()).prefault({}),
});
$(() => { registerMvuSchema(StatDataSchema); });
```

- It runs on the page, so it is cut to an allowlist before install: the one `mvu_zod` import, `const`/`let`/`var` built only from `z.<member>(...)` and literals (members: `string number boolean null any object looseObject tuple union array record coerce passthrough catchall prefault`), one `registerMvuSchema(...)` call, comments. Anything else is removed with a toast naming the lines.
- The root is `z.looseObject({...})` with NO `.prefault` on it. A closed root strips every root it does not name (`GameLogicPlugin`, `EventPack`, `mvuhelper`). Keep `GameLogicPlugin` declared open as shipped.
- Inside, a `z.object` level strips any key it does not declare. `z.looseObject` / `.passthrough()` keeps extras, but a key the engine reads still belongs in the schema.
- `z.coerce.boolean()` turns the string `"false"` into `true`. Teach models to write JSON `true` / `false`.
- ArtificKoi's root is a closed `z.object(...).prefault({})` with `GameLogicPlugin` declared open. That installs with a warning. Do not copy it.

**(b) The narrator's vocabulary** is a constant narrator entry that teaches the pair rule and the only paths the narrator may write. ArtificKoi does this in its `COT_Guide` entry (a "THIS SLICE: the ONLY paths you may write" list of `/Intent/<channel>/0` lines, each with its value grammar), next to `CURRENT_VARIABLE_DATA`, an EJS window that prints the live state. It ships no `<Schema_Syntax>` block. The `<Schema_Syntax>` format (one line per path, annotated `#tuple<number,string>`, `#record<string,object>`) suits a card whose narrator writes state directly. In this design the narrator writes only `/Intent`, so list only those paths:

```
<Variable_Rules>
- End every reply with <UpdateVariable><JSONPatch>[ ... ]</JSONPatch></UpdateVariable>. Nothing to report: [].
- Every value is a pair [value, "Label"]. Write the value at /0 with "replace". Never "add" on a /0 path,
  never touch /1, never write the whole pair.
- Write a path ONLY when this reply's prose shows it. You never write any other path; the engine computes every stat.
  /Intent/training/0  string "<Stat>:<1-3>"   the reply SHOWS {{user}} training. Stat=Int|Str. 1 short, 2 focused, 3 all day.
  /Intent/money/0     string "<signed int>"   money changed hands this reply. A 480 spend is "-480".
</Variable_Rules>
```

A PRE or POST call gets its own list in its own `[PRE]` / `[POST]` entry. Shared reference text (a cast roster) goes in one group entry, `[llmshare] ...`, and the tag goes into `GROUP_TAGS` in `tools/entry_routes.cjs` (`{ llmshare: ['PRE', 'POST'] }`) so `npm test` checks it in both passes.

## 4. One channel end to end: `/Intent/training`

1. **Declared:** `"training": ["", "Training"]` in the seed, `training: labeledStr` in `intentSchema`.
2. **Taught:** the `/Intent/training/0` line in the vocabulary entry.
3. **Reported:** the narrator writes a study session, then `{ "op": "replace", "path": "/Intent/training/0", "value": "Int:2" }`.
4. **Resolved:** MVU applies the patch, MVU Helper calls `resolveTurn`, the engine parses and validates `Int:2`, applies its rules (ArtificKoi pays only the first session of each school week), writes `Player.Int`, logs, and clears the channel.
5. **Shown:** the next reply's EJS window prints the new `Int`.

```js
function applyTraining(sd, raw, log) {
    const [stat, amountText] = String(raw).split(':');
    const amount = Number(amountText);
    if (!['Int', 'Str'].includes(stat) || !(amount >= 1 && amount <= 3)) { log.push('training ignored (malformed): ' + raw); return; }
    const player = sd.Player || (sd.Player = {});
    const next = Math.min(100, (Number(get(player[stat], 0)) || 0) + amount);
    setVal(player, stat, next);
    log.push('training: ' + stat + ' +' + amount + ' -> ' + next);
}
```

Channel design rules:

- Name it after what happened (`training`, `money`, `arrive`), camelCase, under `Intent`. `/Intent/eventFire` is the event system's, never reuse it.
- One owner per channel: the narrator, a PRE call or a POST call. Traffic from the wrong owner is warned and dropped, never applied.
- Observations, never verdicts: `gate:<die>`, never `gate:Success`. When a channel misbehaves, a judgment leaked into it. Turn the judgment into an observation. Never make the prompt louder.
- Several items: `,`-joined, fields split by `:` or `;`. Parse strictly. A malformed item is warned and pays nothing.

## 5. Same reply protection, the minimum

For every mechanic ask: when does the narrator need the result? If the prose needs it, it must be in front of the narrator before it writes: EJS computed from state, a `preAssemblyPatch` write, a PRE call's `<JSONPatch>`, or a `pickSameRoundEvent` pick. Otherwise you get the "one reply late" bug.

```ejs
<%_ const _gmDice = globalThis.MvuHelper.rollPool(4, null, 'NARRATE', 20); _%>
Your dice, use them in order: <%= _gmDice.join(' ') %>. Report the die you used, never the outcome.
```

- `rollPool(count, hash, poolName, sides)` is synchronous, on the page. 1 to 20 dice, 2 to 1000 sides, 20 by default. The same pool name and size give the same dice for the whole generation. A non-null `hash` seeds them.
- The engine gets that generation's dice as `ctx.dice` (flat, every pool) and `ctx.dicePools`. It recomputes the DC itself and checks the reported die: `ctx.dice.includes(die)`. ArtificKoi warns `DIE NOT FROM POOL` and applies anyway.
- Once only: clear every channel you used, and stamp the reply (section 7.1). Full design: [Same reply protection](../gamelogic_engine/same_reply.md). Read it before your second mechanic.

## 6. pack.json

```json
{
  "format": "1.0",
  "packType": "gamelogic",
  "id": "my-game",
  "name": "My Game",
  "description": "One line, shown in the library.",
  "version": "0.1.0",
  "engineOrder": ["gameLogic.cjs"]
}
```

| Key | Rule |
| --- | --- |
| `format`, `packType` | `"1.0"`, `"gamelogic"` |
| `id` | kebab-case, never `registry`. Prefixes every lorebook comment the install writes. Keep it once published |
| `name`, `description` | required |
| `version` | `M.m` or `M.m.r`, numbers only (`"v1.4"` is refused). Install compares it: same = Repair, newer = Upgrade |
| `engineOrder` | every file in `engine/`, each exactly once. Joined in this order with no separator. End each file with a newline |
| `state`, `exposes`, `builtWith` | optional: save fixes ([state](../gamelogic_engine/state.md)), interfaces for plugins ([exposes](../gamelogic_engine/exposes.md)), a note |

An unknown key is warned and not installed. `layout`, `targetsPackId`, `requires`, `optionalUses` or `events` gets the pack refused.

## 7. The engine

### 7.1 Skeleton

```js
const ENGINE_VERSION = 'v0.1.0';   // bump on every change; reported, never compared
const ENGINE_NAME = 'my-game';     // which game: plugins branch on it
const ENGINE_TYPE = 'rpg';         // which family of games

// A stored value is a [value, "Label"] pair: read the value, keep the label on a write.
const get = (t, d) => (Array.isArray(t) ? t[0] : (t === undefined ? d : t));
const setVal = (obj, key, v) => { obj[key] = Array.isArray(obj[key]) ? [v, obj[key][1]] : [v, key]; };
const CHANNELS = ['training', 'money'];

function applyTraining(sd, raw, log) { /* section 4 */ }
function applyMoney(sd, raw, log) { /* parse the signed int, floor at 0, setVal, log */ }

function resolveTurn(statData, ctx) {
    const I = statData.Intent || (statData.Intent = {});
    const key = ctx.mid + ':' + ctx.swipe;
    if (get(I.resolvedFor, '') === key) return { statData, applied: false, log: ['already resolved ' + key] };
    const log = [];
    const raw = Object.fromEntries(CHANNELS.map((c) => [c, String(get(I[c], '')).trim()]));
    if (!CHANNELS.some((c) => raw[c])) return { statData, applied: false, log: [] };   // idle reply: nothing to save
    if (raw.training) applyTraining(statData, raw.training, log);
    if (raw.money) applyMoney(statData, raw.money, log);
    for (const c of CHANNELS) setVal(I, c, '');          // consume: a second run finds nothing
    setVal(I, 'resolvedFor', key);                       // stamp: a re-applied block cannot re-run the math
    return { statData, applied: true, log, resBlock: log.join('\n') };
}

module.exports = { ENGINE_VERSION, ENGINE_NAME, ENGINE_TYPE, resolveTurn };
```

### 7.2 Identity

- `ENGINE_VERSION` is required. It is read from the running module, and from source for a pack that is not loaded, by a line match: `const`/`let`/`var`, the name, `=`, a quoted string. Leading spaces are fine. A template literal or computed value is not.
- `ENGINE_NAME` missing is a warning (plugins cannot tell your game). `ENGINE_TYPE` is reported by `MvuHelper.engineInfo().type`. Export all 3.

### 7.3 The hooks

| Hook | Called | `ctx` | Returns |
| --- | --- | --- | --- |
| `resolveTurn(statData, ctx)` required | after MVU parses the narrator's reply (RES1), once per reply | `{ mid, swipe, dice, dicePools, ops, sameRoundEventKey }` | `{ statData, applied, log, resBlock?, textReplacements? }` |
| `resolvePostRelay(statData, ctx)` | after POST's blocks apply, same reply (RES2) | `{ mid, swipe, dice, dicePools, ops }` (ops include `by: 'post'`) | same as `resolveTurn` |
| `preAssemblyPatch(statData, ctx)` | before PRE and the narrator, every story turn. `statData` = the base floor | `{ type: 'normal'\|'regenerate'\|'swipe', mid, swipe, generationAttempt }` | JSON Patch ops (`add`/`replace`/`remove`, `/` paths), or `[]` |
| `pickSameRoundEvent(statData, ctx)` | after the PRE calls, before the narrator (Extra LLM Calls on, a PRE call ran) | `{ type, mid, swipe, generationAttempt, preOutputs: [{ name, output }] }` | an event key, or `''` |

- `ctx.ops` = `[{ path, old, new, by }]`, dotted paths, at most 500; `by` is `message`, `pre-sim`, `post`, `plugin:<id>`, `statusmenu:<id>` or `host`. Your own writes never appear. `ctx.dice` / `ctx.dicePools` are `null` when nothing was dealt.
- Every call crosses the Worker as a copy. Return the `statData` you changed. Only `applied: true` saves.
- `log` prints as `[mvu-helper] [logic-engine] [RES] <mid>:<swipe>: applied=true → <lines joined by |>` (Pipeline domain).
- `resBlock` is a body only: MVU Helper wraps it in `<RES_Variable>` (RES2: `<RES_POST_Variable>`). `textReplacements` is `{ find: put }`, literal text, applied to the reply.
- A hook may be `async`. No call has a time limit. Loading times out after 10 seconds. A throw leaves the reply unresolved, with an error line and a toast.
- Details: [The hooks in detail](../gamelogic_engine/hooks.md).

### 7.4 Sandbox and host API

- Allowed: the JavaScript built-ins (`Math`, `Date`, `JSON`, `Map`, `Set`, `Promise`, `Intl`, typed arrays...), `console`, `crypto`, `structuredClone`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`. Everything else throws and logs `[mvu-helper] [logic-engine] BLOCKED ...` once per name: timers, `fetch`, DOM, storage, `require`, `import()`.
- Inside the engine, `globalThis` and `window` are a private object per engine, not the Worker global. It carries `MvuHelper`: `engineInfo()`, `log` (`error`, `warn`, `lifecycle`, `verbose`, `trace`, `domain(name, level, ...)`, `child(tag)`, `enabled(level)`, `domainEnabled(name)`), `settings` (`get(name)` and `names()` for MVU Helper's settings by name, like `debug.pipeline`; `set` changes nothing in the engine and returns `false`) and `messages` (`count(role)`, `at(i)`, `latest(role)`, `find({ role, from, direction, skip })`, never message text).
- `globalThis.MvuHelper.log.child('RES').warn('x')` prints `[mvu-helper] [engine:game] [RES] x`.

### 7.5 Several engine files

Files are joined in `engineOrder` into one script. A top-level name in one file is visible in every later file. The same top-level name in 2 files is a SyntaxError and the whole engine fails to load. The last `module.exports` is the API. ArtificKoi wraps each file in an IIFE and hands values on through `globalThis.__NAME__` (`__I18N_API__`, `__EVENTPACK__`).

### 7.6 Calling the engine from EJS

Every top-level function export is on the page as an `async` `globalThis.LogicEngine.<name>`. Nested objects and non-functions are not. It is missing on a card with no engine and for a moment during every reload, so guard it:

```ejs
<%_ let _gmQuests = ''; const _gmLE = globalThis.LogicEngine;
    if (_gmLE && typeof _gmLE.questLines === 'function') _gmQuests = await _gmLE.questLines(getvar('stat_data')); _%>
<%- _gmQuests %>
```

### 7.7 Test it in Node

Add `tools/test_engine.cjs` and append `&& node tools/test_engine.cjs` to the `test` script in `package.json`. It loads the engine the way MVU Helper does (joined, run with `module` / `globalThis` shadowed). It is not the sandbox.

```js
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'workspace', 'gamelogic');
const pack = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
const code = pack.engineOrder.map((f) => fs.readFileSync(path.join(dir, 'engine', f), 'utf8')).join('');
const log = { error() {}, warn() {}, lifecycle() {}, verbose() {}, trace() {}, domain() {}, enabled: () => false, domainEnabled: () => false };
log.child = () => log;
const host = { MvuHelper: { log, engineInfo: () => ({}), messages: {} } };
const mod = { exports: {} };
new Function('module', 'exports', 'window', 'globalThis', code)(mod, mod.exports, host, host);
(async () => {
    const sd = { Player: { Int: [10, 'INT'] }, Intent: { training: ['Int:2', 'Training'], money: ['', 'Money Change'], resolvedFor: ['', 'Resolved For'] } };
    const r = await mod.exports.resolveTurn(structuredClone(sd), { mid: 3, swipe: 0, dice: null, dicePools: null, ops: [], sameRoundEventKey: '' });
    if (!r.applied || r.statData.Player.Int[0] !== 12 || r.statData.Intent.training[0] !== '') { console.error('FAIL', r.log); process.exit(1); }
    console.log('engine test PASSED');
})();
```

## 8. Entries

- Each entry is `<name>.txt` + `<name>.json` with the same stem. A lone half, or any other file type under `entries/`, is an error.
- The sidecar is a Tavern Helper lorebook entry minus `content`: `comment`, `type`, `keys`, `position`, `depth`, `order`, `enabled`... It may not carry `content`, `uid` or `display_index`. Write `"type": "constant"` as a STRING. A boolean `"constant": true` is refused (Tavern Helper drops it and the entry never injects).
- Install prefixes the comment with `[GameLogicPack:<id>] `. Never write `[mvu_`, `[GameLogicPack:`, `[StatusMenuPack:` or `[GameLogicPlugin:` yourself.

| Comment | Read by | Sidecar |
| --- | --- | --- |
| no `[...]` tag | the narrator | `"type": "constant"`, `"enabled": true` |
| `[PRE] ...`, `[POST] ...`, `[<callName>] ...` | that call (EJS1 for PRE, EJS3 for POST) | `"type": "selective"`, `"keys": []` |
| `[<groupTag>] ...` | every member call of the group | same, plus the tag in `GROUP_TAGS` |
| `[InitVar] ...`, `[Initmvuhelper] ...` | MVU / MVU Helper, as data | `"type": "selective"`, `"keys": []`, `"enabled": false` |

A call takes its tag from anywhere in the comment or keys, enabled or not. Put the tag first anyway: `tools/entry_routes.cjs` reads only a leading tag. A selective entry with no keys never reaches the narrator, which is how ArtificKoi keeps its `[PRE]` / `[POST]` entries out of the narrator's prompt.

**EJS rules**

- `<%_ _%>` runs code, `<%= %>` prints escaped, `<%- %>` prints raw (JSON).
- All entries of one pass (narrator, PRE, POST) compile as ONE scope, including the entries of every plugin or sample installed on the card. A top-level name declared twice in a pass sends the whole pass to the model as raw template text, which still reads like prose. Prefix (`_gm...`) or declare inside a block.
- A name a `<%= %>` tag prints is declared outside the `try` that fills it.
- No `%>` or `<%` inside a comment in a scriptlet: it ends the scriptlet.
- Read with the full path: `getvar('stat_data.Player.Int[0]')`. In PRE/POST entries `getvar('Player')` is empty. Never `setvar`: the render writes to the live message, and the prompt is built more than once per reply.
- Keep `if` gates flat, and no literal `{` or `}` in the text inside a gate.
- EJS runs before macros, so `'{{mvuhelperEngineName}}'` in code is the raw token. Branch on `MvuHelper.engineInfo()`.
- In a call's entries: `{{mvuhelper::history::N}}`, `{{mvuhelper::userLine}}`, `{{mvuhelper::callOutput::<name>}}` (POST only), never `{{lastCharMessage}}`. See [What a call reads](../extra_llm_calls/prompts.md).
- A PRE call writes state with a bare `<JSONPatch>[...]</JSONPatch>` (applied before the narrator). A POST call needs the `<UpdateVariable>` wrapper.

## 9. Regex

- One regex object per `.json`. `script_name` is its identity, unique in the pack. `find_regex` is required.
- Set every `source` flag. Without `"ai_output": true` it never runs on replies.
- `destination.prompt: true` rewrites what the model reads and needs `"prompt_rewrite_intended": true`.
- A `replace_string` containing `html>`, `<head>` or `<body` refuses the pack.
- `regex/regex-order.json` is optional. When present it is an array listing every `script_name` exactly once, in apply order.
- Ship a prompt-only regex for every block the narrator must not copy: `<RES_Variable>`, `<RES_POST_Variable>`, `<POSTUpdateVariable>`. ArtificKoi's `PromptDeTagRESVariable` carries `"find_regex": "/<(RES_Variable|RES_POST_Variable)>(?:(?!<\\1>)[\\s\\S])*?<\\/\\1>\\n?/g"`, `"replace_string": ""`, `"destination": { "display": false, "prompt": true }`, `"prompt_rewrite_intended": true`. See [Regex](../gamelogic_engine/regex.md).

## 10. Workflow: from a plain card to a first resolved turn

1. **Check the rig.** MCP `list_pages` shows the SillyTavern tab. Ask the user to confirm `npm run dev` runs, the Artifact dev loop pill reads **Connected**, the card's chat is open, and Main tab > Debug has verbosity at lifecycle and the Pipeline domain on.
2. **Read the card.** Description, greeting, lorebook. List the mechanics (stats, rules, gates, events). For each, decide the observation, its channel, its owner and when the narrator needs the result. Show the user that list and let them rule before you build.
3. **Identity.** Edit `pack.json` (`id`, `name`, `description`, `version`) and the 3 constants. Verify: the console prints `[mvu-helper] [artifact-dev-loop] gamelogic "<id>" v0.1.0 ...` and `[mvu-helper] [logic-engine] loaded v0.1.0 ... name: <ENGINE_NAME>, pack: <id> ... exports: resolveTurn`. If the loop asked Install all / Not here, that answer is the user's. With Not here, the user installs the pack from the library row.
4. **Seed and schema** (sections 3.1, 3.3a). Verify: the stat_data read below shows every root. Tavern Helper > Scripts > character scripts > `Scheme` holds your schema, and no toast named removed lines.
5. **Narrator entries.** The vocabulary entry and a state window (EJS printing what the narrator needs, prefixed names). Verify: `npm test` passes.
6. **The engine, one channel.** `resolveTurn` with clear and stamp, plus `tools/test_engine.cjs`. Verify: `npm test` passes, then a dry call on the page (it never saves): `async () => { const c = SillyTavern.getContext().chat; const s = structuredClone((await Mvu.getMvuData({ type: 'message', message_id: c.length - 1 })).stat_data); s.Intent.training[0] = 'Int:2'; return (await LogicEngine.resolveTurn(s, { mid: -1, swipe: 0 })).log; }`.
7. **Play one reply** (the user, or you one turn at a time when allowed). Verify, in order: the reply ends with your `<UpdateVariable>` block; `[mvu-helper] [logic-engine] [RES] fired ... pending: training=Int:2  money=-  resolvedFor=-`; `[mvu-helper] [logic-engine] [RES] 7:0: applied=true → training: Int +2 -> 12`; the stat_data read shows `Player.Int` `[12, "INT"]`, `Intent.training` `["", "Training"]`, `Intent.resolvedFor` `["7:0", ...]`; a `<RES_Variable>` receipt in the reply.
8. **Regexes** (section 9). Verify: the receipt still shows on screen, and later replies never copy it.
9. **PRE / POST when a mechanic needs them.** Write `[Initmvuhelper]`, have the user assign each call's Connection, add `[PRE]` / `[POST]` entries, export `resolvePostRelay` for POST-owned channels. Verify: `globalThis.mvuHelper.lastPre` / `.lastPost` hold the answers, `[mvu-helper] [small-llm] [PRE] ...` lines, a `[RES2] ... applied=` line.
10. **Repeat per mechanic.** `npm test` after every change. Bump `ENGINE_VERSION` on every engine change, the pack `version` on every shipped change.

**Reading state through the MCP** (`evaluate_script`):

```js
async () => { const c = SillyTavern.getContext().chat; return (await Mvu.getMvuData({ type: 'message', message_id: c.length - 1 })).stat_data; }
() => MvuHelper.engineInfo()                              // { name, type, version, packId, exposes }, all null = no engine
() => Object.keys(globalThis.LogicEngine || {})          // the callable exports
async () => (await MvuHelper.packInfo()).disagreements   // empty = card and library agree
```

Filter the console by `[mvu-helper]` for the whole turn, by `[RES]` for the engine.

## 11. Symptom > cause > fix

| Symptom | Cause | Fix |
| --- | --- | --- |
| The model answers from raw `<%_` text, or from a branch that never ran | an entry's EJS fails to compile: syntax, or one top-level name twice in a pass | `npm test`, prefix names, declare inside blocks |
| A new field is gone after the next reply | not declared in the Zod schema (a `z.object` level strips it) | add it to the schema AND the seed in the same pass |
| `engine failed to load` / `engine scope "" failed to load`, `LogicEngine` undefined | syntax error, a top-level name in 2 engine files, a blocked global at load, a load over 10 s | read the error, fix, check the `loaded` line |
| `MvuHelper is not defined` in an engine line | bare `MvuHelper` in engine code | `globalThis.MvuHelper` |
| Pill **Not applied**, `[artifact-dev-loop] SKIPPED <name> ... <reason>` | an assembly or validation error | fix the file the reason names |
| `... carries a boolean "constant"` | `"constant": true` in a sidecar | `"type": "constant"` |
| An entry never reaches the narrator | `selective` with no keys, `"enabled": false`, or a `[...]` tag in its comment | `"type": "constant"`, enabled, no tag |
| A `[PRE]` rule shows up in the narrator's prompt | the routed entry is enabled and `constant` | `"type": "selective"`, `"keys": []` |
| EJS prints `[object Promise]` | `LogicEngine.<fn>` called without `await` | `await` it |
| `wrote /Intent/<channel> WITHOUT its /0` warning, channel empty | the op targets the pair, not its value | teach `/Intent/<channel>/0` in the vocabulary entry |
| An op on a pair path is lost, nothing logs | `add` on a `/0` path inserts a 3rd slot and Zod refuses it | `replace` on every pair path |
| A reply's effect applies twice (money taken twice) | channel not cleared, no `resolvedFor` stamp, or the stamp is not in the schema | clear every channel, stamp, declare the stamp |
| The state catches up one reply late | the result is computed after the narrator | move it to EJS, `preAssemblyPatch`, a PRE patch or `pickSameRoundEvent` |
| `resolveTurn` ran but nothing saved | `applied: false`, or the changed `statData` not returned | return `{ statData, applied: true, log }` |
| `getvar('X')` empty in a PRE / POST entry | short path | `getvar('stat_data.X')` |
| A `{{...}}` comparison in EJS is always false | EJS runs before macros | `MvuHelper.engineInfo()` |
| `[Initmvuhelper] is not valid JSON` toast, or edits not taking effect | `#` lines inside the wrapper, or no re-import yet | comments outside the wrapper, reopen the chat or Re-import |
| A changed seed value never shows in the open chat | `[InitVar]` is create-only | a new chat; for old saves, `state.forceFromInitVar` (or `state.force`) with a `state.version` bump |
| A boolean the model wrote as `"false"` reads `true` | `z.coerce.boolean` | JSON `true` / `false` in the vocabulary |
| A die in the reply is not in the dealt pool | the narrator invented it, or EJS rolled it without `rollPool` | deal with `rollPool`, check `ctx.dice` |
| The narrator copies `<RES_Variable>` or `<POSTUpdateVariable>` into its reply | the block reaches its prompt | a prompt-only detag regex |

## 12. Done checklist

- [ ] `pack.json`: real `id` / `name` / `description`, numeric `version`, `engineOrder` matching `engine/` exactly.
- [ ] Engine: 3 literal identity constants exported, `ENGINE_VERSION` bumped. `resolveTurn` returns `{ statData, applied, log }`, clears every channel it read, stamps `resolvedFor`. Host API only through `globalThis.MvuHelper`. No `console.*`, no `Math.random` for anything shown.
- [ ] Every channel: one owner, one observation, a strict parser that warns on bad input, a line in the right vocabulary entry.
- [ ] `[InitVar]`, the Zod schema and the vocabulary agree, path for path. The schema root is `z.looseObject` with `GameLogicPlugin` open.
- [ ] `[Initmvuhelper]` exists when the game uses PRE/POST, the stat box or imagegen, and there is exactly one on the card.
- [ ] Sidecars use `"type": "..."` strings. Routed entries are `selective` with no keys. Group tags are in `GROUP_TAGS`.
- [ ] Every top-level EJS name is prefixed. Full `getvar` paths. Every `LogicEngine` call awaited and guarded. No `setvar`.
- [ ] Dice dealt with `rollPool`, checked against `ctx.dice`.
- [ ] Prompt-only regexes hide every engine block from the narrator.
- [ ] `npm test` passes (scope scan + engine test). One live reply shows the `[RES] fired ... pending:` and `applied=true` lines, and `stat_data` holds the result.

## The full pages

[What is GameLogic Engine](../gamelogic_engine/README.md) · [How it works](../gamelogic_engine/technical.md) · [Same reply protection](../gamelogic_engine/same_reply.md) · [What's in a pack](../gamelogic_engine/pack.md) · [The hooks in detail](../gamelogic_engine/hooks.md) · [Where the engine runs](../gamelogic_engine/runtime.md) · [Entries](../gamelogic_engine/entries.md) · [Schema](../gamelogic_engine/schema.md) · [Regex](../gamelogic_engine/regex.md) · [State corrections](../gamelogic_engine/state.md) · [Exposes](../gamelogic_engine/exposes.md) · [Import, install and uninstall](../gamelogic_engine/install.md) · [MVU Squad](../mvu_squad/README.md) · [What a call reads](../extra_llm_calls/prompts.md) · [Set up the calls](../extra_llm_calls/calls.md) · [Stat box](../stat_box/technical.md) · [Macros and API](../macros_api/technical.md) · [Development Environment](../dev_env/README.md) · [GameLogic Plugin quick guide](gamelogic_plugin.md)

[Back to QuickStart Guide](../quickstart.md)
