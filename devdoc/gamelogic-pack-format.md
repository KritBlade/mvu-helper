# GameLogic Pack format — what mvu-helper accepts

Audience: anyone writing a game for mvu-helper — the engine that resolves every turn, and the card pieces
that go with it. This is mvu-helper's side of the contract: what a GameLogic Pack is, how you build and
install one, what mvu-helper reads from it, what it calls, and what it refuses.

A worked example is School v4 (MvuGameMaker, `maker-app/GameLogic/Schoolv4/workspace/gamelogic/`). Its
engine is described in `Schoolv4/doc/GameLogicEngine_Guide.md`.

---

## 1. What a GameLogic Pack is

A GameLogic Pack is the game. It carries:

- the **engine** — JavaScript that mvu-helper runs in a sandboxed Worker and calls at fixed points of every
  reply (§4);
- the card's **prompt entries** (§5), its **Zod schema** (§6) and its **regexes** (§7);
- **state corrections** applied to existing saves (§8);
- the **interfaces** it offers plugins (§9), and an optional **side-panel** slot (§10).

One GameLogic Pack is active per card. Installing it writes each piece onto the card and records what it
wrote, so Repair, Upgrade, Uninstall and Export always know exactly which pieces are the pack's (§11).

---

## 2. Building and using one

1. **Start from the skeleton.** Development tab → **Add New Blank Packs** → type *GameLogic Pack* →
   **Create archive**. The ZIP holds a `gamelogic/` folder with a working minimum: `pack.json`, an engine
   that exports `resolveTurn`, a disabled example entry, a sample regex and a sample schema. Extract it at
   your workspace root.
2. **Develop against a live card.** In the mvu-helper repo run `npm run dev -- <workspace>` (port 6620 by
   default). In SillyTavern, Development tab → **Artifact dev loop** → **Watch the local dev server**.
   Every save re-assembles the folder, runs the same checks an import runs, and applies the changed part to
   the open card: an `engine/` save rewrites and reloads the engine, `entries/` and `panel/` rewrite the
   entries, `schema/` the schema, `regex/` the regexes, and `pack.json` everything. An artifact with errors is
   skipped. The loop asks before installing onto a card that does not have the pack yet, asks once before
   replacing pieces the card already owns (§11), never uninstalls anything, and never applies in the lobby.
   An apply stops when the open card changes under it, and runs again on the card that is open then.
3. **Import.** On the GameLogic Packs tab: **Import source folder** or **Import source ZIP** for the folder; **Load
   file** or paste, then **Validate** and **Add to library**, for the single pack file. Every import goes to the
   **library** first — a worldbook bound to no character, so it survives rebuilding the card. Every door —
   folder, ZIP, file, paste, the dev loop, and each install from the library — judges a pack the same way:
   the format rules below, then the source checks the dev loop runs. The StatusMenu Packs tab carries the same
   Import card, and either one takes every type: a StatusMenu Pack is listed on the StatusMenu Packs tab, a plugin
   on this one, and an event pack goes to the Event Packs tab's own library.
4. **Install.** On the library row: **Install to this card**. The **On this card** row then shows the
   pack's state (Installed, Pieces missing, No library copy) and offers Export and Uninstall, plus Repair
   when pieces are missing from the card and Upgrade when the library holds a newer version. The engine and
   the schema are pieces too; when another writer has replaced either (an engine dev upload, a hand edit), the
   row adds a Drift pill naming it and offers Repair, which writes the pack's copy back.

---

## 3. The folder and the file

You author the FOLDER. mvu-helper assembles it into the FILE — one JSON object — and every install reads
the file.

```
gamelogic/
├── pack.json           identity, engineOrder, state, exposes
├── engine/             the engine: one or more files, joined in engineOrder
├── entries/            one prompt entry = <name>.txt (its content) + <name>.json (its fields)
├── schema/             exactly one file: the Zod registration script
├── regex/              one regex object per .json file; regex-order.json = their order
└── panel/panel.json    optional side-panel declaration
```

- Only `pack.json` sits at the root, and only these directories (`layout/` and `events/` belong to other
  pack types and are refused here). Any path with a segment starting with `.`, and any `README.txt` or
  `README.md`, is ignored.
- **`pack.json`** carries the top-level fields below, plus `engineOrder`. `state` and `exposes` exist only
  here — no directory produces them.
- **`engine/`** — `engineOrder` must name every file in `engine/`, and every name must exist. The files are
  joined in that order, with no separator, into the one `engine` string. A file that does not end with a
  newline is warned: its last line would merge with the next file's first. `engineOrder` itself is not part
  of the file.
- **`entries/`** — any depth. Each `<stem>.txt` needs a `<stem>.json` beside it and vice versa. The sidecar is
  a TavernHelper lorebook entry minus `content`; it may not carry `content`, `uid` or `display_index`, and
  `constant` / `selective` / `vectorized` are written as `"type": "constant"` (a boolean is refused, because
  TavernHelper drops it and the entry never injects). Entries are ordered by path.
- **`regex/`** — every file except `regex-order.json` is one regex object. `regex-order.json` is an array of
  `script_name`s and becomes `regexOrder`.
- **`schema/`** holds exactly one file, any name. **`panel/`** holds only `panel.json`.

**A workspace** may hold several artifacts: a folder with its own `pack.json` is one artifact; otherwise each
immediate subfolder with a `pack.json` is one. Subfolders without one are not artifacts.

### Top-level fields of the file

| Field | Required | What mvu-helper does |
| --- | --- | --- |
| `format` | **yes** | `"<major>.<minor>"`. This mvu-helper understands `"1.0"`. |
| `packType` | **yes** | `"gamelogic"`. |
| `id` | **yes** | kebab-case. It prefixes every lorebook comment the install writes, so keep it stable once published. `"registry"` is reserved. |
| `name` | **yes** | Display name, any script. |
| `description` | **yes** | One line, shown in the library and the install dialog. |
| `version` | no (warned) | Two or three whole numbers separated by dots (`"1.4"`, `"1.4.0"`); anything else (`"v1.4"`, `"1.4-beta"`) is refused. Compared number by number on install to tell Upgrade, Repair and Downgrade apart, and on the card row to offer Upgrade. |
| `builtWith` | no | A receipt naming the tool that produced the file. Stored, never interpreted. |
| `engine` | no | The engine as one string (§4). |
| `entries` | no | Prompt entries (§5). |
| `schema` | no | The Zod registration script (§6). |
| `regex`, `regexOrder` | no | Regexes and their order (§7). |
| `state` | no | `{ version, force, forceFromInitVar }` (§8). |
| `exposes` | no | Interface map for plugins (§9). |
| `panel` | no | Side-panel declaration (§10). |

A top-level key not in this table is warned and not installed; every other section still installs. A
section that belongs to another pack type (`layout`, `targetsPackId`, `requires`, `optionalUses`, `events`)
is refused.

### Checks on the content

Every import, every install and every dev-loop save also checks what the sections contain:

- the engine compiles;
- each entry's EJS scriptlets compile together as one function body;
- no two enabled `constant` entries declare the same top-level name in their EJS (they render in one scope);
- the engine declares `ENGINE_NAME` (a warning: plugins that branch on the game's name cannot tell yours).

---

## 4. The engine

One script, ending in a `module.exports` of declarations and hooks:

```js
const ENGINE_VERSION = 'v0.1.0';   // required — a string literal on its own line
const ENGINE_NAME = 'my-game';     // which game; plugins branch on it
const ENGINE_TYPE = 'my-game';     // which family it belongs to

function resolveTurn(statData, ctx) {
    // read what the narrator reported, decide, write the result
    return { statData, applied: false, log: [] };
}

module.exports = { ENGINE_VERSION, ENGINE_NAME, ENGINE_TYPE, resolveTurn };
```

### 4.1 Declarations

- **`ENGINE_VERSION`** is required. mvu-helper reads it from the running module, and reads the same line from
  the source when checking a pack that is not loaded yet, so write it as a string literal on a line of its own
  and export it. It is shown on the load line and by `{{mvuhelperEngineVersion}}`; it is never compared — the
  pack's `version` is what an install compares.
- **`ENGINE_NAME`** names the game: the load line, `MvuHelper.engineInfo().name`, `{{mvuhelperEngineName}}`,
  and every plugin that asks which game it is running on read it.
- **`ENGINE_TYPE`** names the family; `MvuHelper.engineInfo().type` reports it.
- **`EVENT_PACK_ADAPTER`** and **`EVENT_PACK_FORMAT`** make the card able to host event packs (§4.6).

### 4.2 The hooks

mvu-helper calls these exports by name. `resolveTurn` is what resolves a turn; each other hook adds one
capability, and an engine that does not export it simply does not have that capability.

| Hook | Called | Receives | Returns |
| --- | --- | --- | --- |
| `preAssemblyPatch` | before the PRE calls and the narrator | the base floor's state; `{ type, mid, swipe, generationAttempt }` | JSON Patch ops, or `[]` |
| `preVerdictPatch` | after the PRE calls, before the narrator | the base floor's state; `{ type, mid, swipe, generationAttempt, preOutputs }` | JSON Patch ops, or `[]` |
| `pickSameRoundEvent` | after the PRE calls, before the narrator | the base floor's state; `{ type, mid, swipe, generationAttempt, preOutputs }` | an event key, or `''` |
| `resolveTurn` | after the narrator's reply is parsed (RES1) | the reply's state; `{ mid, swipe, dice, dicePools, ops, sameRoundEventKey }` | `{ statData, applied, log, resBlock?, textReplacements?, leadText?, endText? }` |
| `resolvePostRelay` | after the POST calls' blocks are applied (RES2) | the reply's state; `{ mid, swipe, dice, dicePools, ops }` | the same as `resolveTurn` |

Every call crosses the Worker boundary: the arguments and the result are copies. Return the state you
changed; changing the argument alone changes nothing on the page. A hook may be `async`. No call has a time
limit. Only top-level function exports are callable.

**`resolveTurn(statData, ctx)` — RES1.** Runs once per reply, after MVU has parsed the narrator's reply (a
regenerate or a swipe is a new reply). Updates that are not the reply itself — an older floor MVU replays, a
PRE-call patch, a plugin's or a StatusMenu action's write — do not call it. `statData` is the reply's state
without MVU's own `$internal`, which MVU keeps on the state only while it applies an update and removes itself.

- `ctx.mid`, `ctx.swipe` — the reply's message index and swipe.
- `ctx.dice`, `ctx.dicePools` — the dice dealt this generation (§4.4): flat, and per pool as
  `{ pool | hash, sides, dice }`; `null` when none were dealt.
- `ctx.ops` — every state change parsed this generation, `[{ path, old, new, by }]`, where `by` is `message`,
  `pre-sim`, `post`, `plugin:<id>`, `statusmenu:<id>` or `host`. Paths are dotted. Your own changes never
  appear. The list holds at most 500 entries.
- `ctx.sameRoundEventKey` — the event mvu-helper played in this reply on your `pickSameRoundEvent`'s answer,
  `''` when none. Whether it fired is yours to judge.

The result:

- `statData` — the new state. It replaces the reply's state.
- `applied` — `true` when you changed state. mvu-helper saves the state only then, and skips the save if
  the chat moved on (a new turn, a swipe) while you ran.
- `log` — an array of strings, printed as one `[mvu-helper] [logic-engine] [RES]` line when the Pipeline
  debug domain is on.
- `resBlock` — the BODY of a player-visible audit. mvu-helper wraps it in `<RES_Variable>` … `</RES_Variable>`
  and writes it into the reply: after the narrator's `</UpdateVariable>`, else above the reply's tail (the
  `endText` block, else the status-menu placeholder), else at the end. Do not write the tags yourself. A body
  carrying `html>`, `<head>`, `<body` or `<%` writes no block, with a warning.
- `textReplacements` — `{ find: replace }` pairs applied to the reply's text as literal replacements. A pair
  whose value is not a string, or whose key is empty, is skipped with a warning, and so is a pair whose swap
  would add `html>`, `<head>`, `<body` or `<%` to the reply. A find the reply does not carry changes nothing,
  so text every reply must show belongs in `leadText` / `endText`, not behind a tag the model may not write.
- `leadText` and `endText` — text your engine writes into the reply itself, whatever the model wrote: a date and
  location bar, a closing line. mvu-helper wraps each in a tag of its own and places it:
  - `<LeadText>` … `</LeadText>` at the top of the story, which your card names in its `[Initmvuhelper]` config
    (below);
  - `<EndText>` … `</EndText>` directly above the status-menu placeholder, or at the end while the reply has
    none yet (MVU appends the placeholder below it). Every block mvu-helper places above the menu goes above the
    `endText` block, so it stays the last one there.

  **Where the story starts.** A reply may open with blocks of the model's own: a preset's thinking written into
  the reply under a tag the preset chose (`<thinking>`, `<konatan_planning~>`), or a commentary block. A preset's
  display regex often folds everything from the reply's first character through such a block's closing tag into
  one collapsed box, and text above the block vanishes into it. So the lead text goes where the story starts, and
  only your card knows which block holds the story. It names the block's opening tags in `[Initmvuhelper]`, in
  every spelling a reply can have:

  ```json
  "leadText": { "storyEnvelope": ["<gametxt>", "<maintext>"] }
  ```

  mvu-helper walks the reply from the top. It skips every complete tag block, whatever its name, and steps INTO
  the story block instead, walking on inside it; `<p>` wrappers, closing tags and comments are passed over. It
  stops at the first story line, at a tag that is no complete block (a `<pic>` tag, a self-closing tag, a block
  never closed), or at the story block's closing tag, and the lead text goes there, in front of the `<p>` that
  opens that line. School's reply `<tucao>…</tucao> <konatan_planning~>…</konatan_planning~> <gametxt>…` gets it
  as the first thing inside `<gametxt>`; the same reply with no story tag gets it right below the planning. The
  section is the card's whole: a card without it gets no lead text, with a warning naming the missing section,
  and an entry that is no bare opening tag is dropped at import, named in the import's warnings. Thinking the
  reply carries without its opening tag (a preset that pre-fills the tag) reads as story to the walk, so the lead
  text goes above it.

  Return them on every reply that should show them: the block is written into each reply on its own, and a
  regenerate or a swipe is a new reply. A later resolve of the same reply (`resolvePostRelay`, a re-fire)
  refreshes the block where it stands instead of adding a second one; a field you leave out leaves the reply's
  block as it is, and an empty string removes it. Do not write the tags yourself: a text carrying either tag, or
  `html>`, `<head>`, `<body` or `<%`, writes nothing, with a warning, and so does a value that is not a string.
  SillyTavern shows the text with its line breaks; your card styles it with a display regex if it wants to.
  The POST calls' input and the reply-cast name scan leave both blocks out. The narrator's prompt does not:
  strip them there with a prompt-only regex on your card, or the model sees the blocks in its history and copies
  them.

Those four tokens are refused because the page would run the reply's text: TavernHelper renders a reply
carrying the first three as a web page with the page's full reach, and ST-Prompt-Template runs `<%` as a
template, both when the reply is shown and in every later prompt. Your engine runs in a sandbox so that its
code never reaches the page (`security-hardening.md` §2), and its text is held to the same line.

If it throws, the reply is not resolved; mvu-helper logs the error and shows a toast.

**`resolvePostRelay(statData, ctx)` — RES2.** Runs in the same reply, after the POST calls' `<UpdateVariable>`
blocks are applied, so what POST records resolves in the reply it describes. `ctx.ops` now also holds
POST's changes (`by: 'post'`). Its `resBlock` is wrapped in `<RES_POST_Variable>` and placed right after
`<RES_Variable>`, else above the reply's tail like `<RES_Variable>`. Without this hook, POST's changes are
still saved, and your engine sees them in the next reply's `resolveTurn`.

**`preAssemblyPatch(statData, ctx)`.** Your engine's deterministic writes before the prompt is built — a
value the PRE calls and the narrator must already see: a counter, a clock step, a placement. `statData` is
the base floor: the last reply with state before the player's message. Return JSON Patch ops (`add` /
`replace` / `remove`, paths starting with `/`), or `[]` when nothing changes; a malformed op is dropped.
mvu-helper applies them to the player's message (`ctx.mid`) through MVU and saves them, so the PRE calls and
the narrator read the result. It runs on every story turn — `ctx.type` is `'normal'`, `'regenerate'` or
`'swipe'`; Continue, quiet and impersonate generations are not turns and run nothing — whether or not Extra
LLM Calls is on. It runs before the PRE calls, so it cannot see this turn's classification; a write that
needs it belongs in `preVerdictPatch`, or in RES1.

A regenerate first puts back every path the previous attempt wrote on that message, then calls the hook
again with the same base floor, the same `type`, `mid` and `swipe`. So a value derived from the base floor
lands the same on every attempt. `ctx.generationAttempt` is what changes: it advances on every generation
(background quiet ones included). An engine whose result should differ per attempt — a fresh encounter when
the player re-rolls a bad one — folds `generationAttempt` into its seed; one whose result should not differ
ignores it.

**`preVerdictPatch(statData, ctx)`.** Your engine's writes that depend on this turn's PRE verdict and that the
narrator must already see — a mode the player's line switches on, whose rules the prompt then carries. It
runs when Extra LLM Calls is on and at least one PRE call ran, after their own patches are applied and before
the narrator's prompt is built. `ctx.preOutputs` is `[{ name, output, appliedOps }]`, one entry per PRE call: its
raw output, and the JSON Patch ops mvu-helper validated and applied from its `<JSONPatch>` blocks this attempt
(`[]` when it wrote none, or its patch was rejected). Read what a call WROTE from `appliedOps`, never by parsing
`output` again: those are the ops that landed. `statData` is the base floor, the state those calls read. Which
field of their output you act on is yours.
Return JSON Patch ops, or `[]`: mvu-helper applies them to the player's message exactly as it applies
`preAssemblyPatch`'s, and a regenerate puts them back the same way before the hook runs again.

**`pickSameRoundEvent(statData, ctx)`.** Lets an event play in the reply it becomes ready in, instead of the
reply after. It runs when Extra LLM Calls is on and at least one PRE call ran. `ctx.preOutputs` is the same
`[{ name, output, appliedOps }]` `preVerdictPatch` gets; `statData` is the same base-floor state those calls read.
Return the key to play now, or `''`. Deciding the key — what the PRE calls were shown, which field of their
output carries the verdict, whether the key named is one you offered — is entirely yours. mvu-helper plays
it: it finds the `@<key>`-gated body in the card's lorebook, renders it, gives it to the narrator with the
instruction to report `/Intent/eventFire` for that key, and hands the key to `resolveTurn` as
`ctx.sameRoundEventKey`. A return that is not a string plays nothing and is warned. School v4's guide walks
through a complete implementation.

### 4.3 Where it runs

- In a Worker inside a hidden frame. There is no DOM, no network and no dynamic `import()`.
- Available: the JavaScript built-ins (`Math`, `Date`, `JSON`, `Promise`, `Map`, `Intl`, typed arrays, …),
  `console`, `crypto`, `structuredClone`, `TextEncoder`, `TextDecoder`, `atob` and `btoa`. Everything else —
  timers included — is blocked: using it throws, and mvu-helper logs the first use of each blocked name. The
  full list is in `security-hardening.md` §2.
- `globalThis.MvuHelper` inside the Worker carries `engineInfo()`, `log` and `settings` (§4.4) and `messages` —
  `count(role)`, `at(i)`, `latest(role)`, `find({ role, from, direction, skip })`, which report message indexes,
  roles and swipes, never text.
- Loading the engine times out after 10 seconds.

**On the page,** `globalThis.LogicEngine` holds one `async` function per function export of your engine, so
the card's EJS entries can call into it (`await LogicEngine.myFunction(...)`). Non-function exports are not
there.

### 4.4 Logging, settings and dice

**Logging.** `globalThis.MvuHelper.log` has `error`, `warn`, `lifecycle`, `verbose`, `trace`,
`domain(name, level, …)` and `child(tag)`. `error` and `warn` always print; the others follow the Debug
settings on the Main tab, and `domain` follows that domain's toggle (`pipeline`, `imagegen`, `roster`,
`smallllm`). Lines print as `[mvu-helper] [engine:game] [<tag>] …`, so
`MvuHelper.log.child('RES').warn('x')` prints `[mvu-helper] [engine:game] [RES] x`.

**Settings.** `MvuHelper.settings.get(name)` reads one of mvu-helper's settings by name, in your entries and
inside the Worker alike: `debug.verbosity` (`'off'`, `'lifecycle'`, `'verbose'` or `'trace'`), `debug.pipeline`,
`debug.imagegen`, `debug.roster` and `debug.smallllm` (`true` or `false`), and `language` (`'en'` or `'zh-cn'`).
`names()` lists them. In an entry, `set(name, value)` turns a debug switch on or off, and returns `false` with a
warning for anything else; inside the Worker it sets nothing. Read the settings this way rather than through
`SillyTavern.extensionSettings`, which hands a template every extension's settings to find one switch, and makes
every install of the pack ask the user first (`security-hardening.md` §6). A trace
gate that keeps a card working without mvu-helper reads
`globalThis.MvuHelper && MvuHelper.settings && MvuHelper.settings.get('debug.pipeline') === true`.

**Dice.** mvu-helper deals dice on the page: card EJS calls `MvuHelper.rollPool(count, hash, poolName, sides)`
while a prompt renders — 1 to 20 dice, 2 to 1000 sides, 20 by default; the same pool name and size return the
same dice for the rest of that generation, and a `hash` makes them seeded. `resolveTurn` and
`resolvePostRelay` receive that generation's dice as `ctx.dice` / `ctx.dicePools`, so a check resolves with
the die the model was shown. `Math.random` and `crypto` work in the Worker, but no model has seen numbers
made there.

### 4.5 In a workspace: several files, one engine

`engine/` may hold several files, joined in `engineOrder` into one script. A name declared at the top level
of one file is visible to every file after it; a name declared at the top level of two files is a
SyntaxError that stops the whole engine loading. The last `module.exports` assignment is the engine's API.

### 4.6 Event packs

An engine that loads the shared event library (`eventpack.cjs`, placed before your engine file in
`engineOrder`) and exports `EVENT_PACK_ADAPTER` and `EVENT_PACK_FORMAT` can host event packs. The contract is `event-pack-engine.md`;
the blank pack's `engine/README.txt` shows the wiring.

### 4.7 Where the engine lives on the card

The install writes the engine into the card's `[MVU_LogicEngine]` lorebook entry (disabled — it is storage,
not prompt text). mvu-helper loads it when a chat opens and after every install, and reloads only when the
text changed. The LogicEngine tab shows the running engine — its declared name, version and exports — and the stored
copy. Its **Enable LogicEngine for this card** (on by default) switches the engine off for one card, and with it the
card's plugins and StatusMenu Engine, which run in the same Worker.

---

## 5. `entries`

Each entry is written into the card's worldbook with its comment prefixed `[GameLogicPack:<id>] `; every
other field is copied verbatim, except `uid`, which belongs to the source book and is dropped. A comment may not contain `[mvu_`, `[gamelogicpack:`, `[statusmenupack:` or
`[gamelogicplugin:` — the installer owns those names.

The card's MVU seed is an ordinary entry: ship the card's `[InitVar]` entry here, as any MVU card does (§8).

---

## 6. `schema`

One Zod registration script (`registerMvuSchema` from mvu_zod), installed as the card's character-scoped
TavernHelper script named `Scheme`. The schema MvuStatMenuBuilder generates is exactly what this section
asks for.

- **It may only declare a schema.** TavernHelper runs the script on the page, so it is cut down to an
  allow-list before it is judged or installed. Kept, statement by statement:
  - `import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js'`,
    once;
  - `const`, `let` and `var` declarations (`export` allowed) whose values are built only from `z.<member>(…)`
    calls, strings, numbers, `true`, `false`, `null`, `[…]` and `{ key: value }` literals, and names declared
    earlier in the file. The members are `string number boolean null any object looseObject tuple union array
    record coerce passthrough catchall prefault`;
  - one `registerMvuSchema(…)` call, bare or as `$(() => { registerMvuSchema(…); })`;
  - comments.

  Anything else is removed — the whole statement — along with every statement that uses a name it declared,
  and the rest installs. A comment or string holding `</script`, `<script`, `<!--` or `-->` is removed too.
  Each removal is listed in the import report and the install log, and a toast names the lines.
- **Keep the registered root open:** `z.looseObject({ … })`, or a root with `.passthrough()` or
  `.catchall(z.any())` chained on it. Your pack is not the only writer on a card. mvu-helper keeps two platform
  roots: `GameLogicPlugin`, where plugins name their own keys, and `$mvuhelper`, mvu-helper's own (what each
  character wears, the character registry). Under a closed root (`z.object`) every write into a root it does
  not name is dropped. A closed root is refused, unless the schema also declares both platform roots open;
  then it installs with a warning, because every other root added later is still lost.
- **Declare the platform roots open,** each as `z.record(z.string(), z.any()).prefault({})` (or `z.looseObject(…)`,
  or a form with `.passthrough()` or `.catchall(z.any())`), or leave them out under an open root. A closed
  declaration is refused: it strips every key it does not name on the next write. The blank GameLogic Pack
  from the Development tab ships both declared. The leading `$` keeps `$mvuhelper` out of TavernHelper's
  `{{get_message_variable}}` / `{{format_message_variable}}` output.

---

## 7. `regex` and `regexOrder`

TavernHelper regex objects, installed character-scoped.

- `script_name` is the regex's identity: required and unique within the pack. Install, upgrade and uninstall
  find a regex by it.
- `find_regex` is required. One that does not compile the way SillyTavern parses it is warned.
- A GameLogic regex may hide or restyle text. One whose `replace_string` would make TavernHelper render a
  document (it contains `html>`, `<head>` or `<body`) is refused — ship that in a StatusMenu Pack.
- `destination.prompt: true` rewrites what the MODEL reads, not just the screen. Declare
  `prompt_rewrite_intended: true` on such a regex, or it is warned.
- Set each `source` flag you need explicitly: a regex without `source.ai_output: true` never runs on the
  narrator's replies.
- `regexOrder` lists every shipped `script_name` exactly once, in the order they apply; each regex
  transforms the previous one's output. It orders only the pack's own regexes.

---

## 8. `state`

```json
"state": {
  "version": "1.2.0",
  "force": { "World.Weather": ["Clear", "Weather"] },
  "forceFromInitVar": ["EventPack.triggers"]
}
```

- **The seed is not here.** It is the card's own `[InitVar]` entry, which mvu-helper re-applies to the save on
  every chat load, create-only: it fills what is missing at any depth and never overwrites. So a NEW key reaches
  running chats by itself, and a CHANGED value reaches only new chats, unless one of the two lists below pushes it.
- **`force`** overwrites values that are already present and wrong: a flat map of dotted path → value.
- **`forceFromInitVar`** pushes the card's own `[InitVar]` value at each listed dotted path over the save's, so the
  card carries one copy of the value. List the table itself (`EventPack.triggers`), never its parent: a table — an
  object — goes row by row. Each row the card carries replaces the save's row of that key, unless the two already
  match. A row that differs from the card's only by empty fields the card's schema fills in (`check: ""` where the
  card's row has no `check`) already matches. A row the card does not carry is never deleted: another developer's
  event pack may have installed it. Any other value is replaced whole. A path the card's `[InitVar]` does not reach
  is refused and logged.
- **Once per version.** Each list runs once per save, when `state.version` is newer than the version that save last
  took for that list. Bump `state.version` to push again. The two lists keep separate records, so a save that took a
  version under an mvu-helper older than `forceFromInitVar` still takes the push later. The push runs first, so the
  literal `force` value wins on a path both name in one load.
- **What it reaches.** The two newest saved states of the chat, the ones the next reply or a regenerate starts from.
  A player who deletes back past them returns to a state from before the push, and that save does not take the same
  version again.
- `__proto__`, `constructor` and `prototype` are never state keys: the seed skips one at any depth, and a `force` or
  `forceFromInitVar` path through one is refused and logged.
- `state.version` is required whenever `state` is present, in the same shape as `version` (`"1.2.0"`).
- **Read on chat load:** the sync line in the console names each list —
  `force from [InitVar]: EventPack.triggers 163 of 218 rows replaced (…), 0 not on the card kept · force map: nothing to force`
  the first time, and `version 0.2.0 <= pushed 0.2.0` for the push once the save has it.

---

## 9. `exposes`

```json
"exposes": { "cast@1": "YourCastRoot" }
```

Interface name (`<name>@<major>`) → your own dotted `stat_data` path. School v4, for example, publishes
`cast@1` → `Classmate` and `player@1` → `Mainchar`. A plugin `requires` an interface by
name; mvu-helper matches the name and hands the plugin your path. The install records the map on the card,
so it resolves even after the library file is deleted. The interfaces a game may publish are listed in
`gamelogic-plugin-guide.md` §8.6.

---

## 10. `panel`

A slot in mvu-helper's side panel. `kind` and `format` are read; the rest is carried verbatim and may not
contain `customLogic`. For a GameLogic Pack, the declaration's paths are read against `stat_data` itself, and
an engine that exports `renderPanel(ctx)` computes the slot instead. The format is `side-panel-format.md`.

---

## 11. What install writes, and what it never touches

**Install** (from the library row), **Repair** (same version), **Upgrade** (newer) and **Downgrade** (older —
asks first) all write the same way:

- every recorded entry of the previous install is deleted, then the pack's entries are written;
- the engine into `[MVU_LogicEngine]`, the schema into the `Scheme` script, the regexes into the card's
  regex list — removing the ones a previous version installed and this one no longer ships;
- `[GameLogicPack:Registry]`: what was written and owned, a fingerprint of the engine and schema text it
  wrote, the `state`, the `exposes` map and the pack's identity;
- then the card's state is synced (the `[InitVar]` seed, `forceFromInitVar` and the `force` map) and the engine
  reloads.

**Pieces the card already has.** If the card already carries an engine entry, a `Scheme` script or regexes
of the same names that no install recorded as the pack's: identical ones are taken over silently and logged;
different ones make the install ask once whether to replace them. Taken-over pieces are the pack's from then
on, so Uninstall removes them.

**Switch** — when another GameLogic Pack is active, Install offers to uninstall it first. The save is not
touched either way.

**Uninstall** removes exactly what the install recorded: the pack's entries, the engine and the `Scheme`
script if the pack owns them, its regexes and the registry. It never touches `stat_data`, the card's `mvu`
script, any other entry, or the library copy.

**Export** rebuilds the pack file from the card — the card's copies are the bytes it ships — and refuses
when a recorded piece is missing. The result goes through the same checks as an import.

---

## 12. A minimal pack

```
gamelogic/
├── pack.json
└── engine/
    └── gameLogic.cjs
```

```json
{
  "format": "1.0",
  "packType": "gamelogic",
  "id": "my-game",
  "name": "My Game",
  "description": "A game that resolves its turns.",
  "version": "0.1.0",
  "engineOrder": ["gameLogic.cjs"]
}
```

with `engine/gameLogic.cjs` as in §4. **Add New Blank Packs** produces this, plus the example entry, regex
and schema.
