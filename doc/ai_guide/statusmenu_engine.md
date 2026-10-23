# StatusMenu Pack: quick guide for an AI assistant

This page is for an AI coding assistant (Claude Code, Codex) working in a clone of the `mvu-helper-template` workspace. It covers building or adapting the StatusMenu Pack in `workspace/statusmenu/`. ArtificKoi (School v4) is the real example the template ships. Its names (`Mainchar`, `Classmate`, `Belongings`) are examples, never rules.

Human-facing pages: [What is Status Menu Engine](../statusmenu_engine/README.md), [How it works](../statusmenu_engine/technical.md), [The menu engine](../statusmenu_engine/engine.md), [Where the menu runs](../statusmenu_engine/frame.md), [Install](../statusmenu_engine/install.md), [Inside the status menu frame](../macros_api/technical.md#inside-the-status-menu-frame), [Development Environment](../dev_env/README.md).

## Hard rules

1. **Never hand-edit the 3 generated files:** `layout/layout.json`, `engine/layoutFormatters.cjs`, `regex/StatusMenu.json`. MVU Status Menu Builder rewrites all 3 on every Refresh export. A lasting layout or formula change goes through the builder.
2. **Only `pack.json`, `engine/statusMenuLogic.cjs`, `regex/regex-order.json` and regexes you add yourself (School: `regex/_GameStartMenu__.json`) are hand-written.**
3. **Only `pack.json` and section folders (`engine/`, `layout/`, `regex/`, and `entries/` when the menu ships lorebook entries) may sit in `workspace/statusmenu/`.** Any other file at the artifact root, or an unknown folder, refuses the whole pack (`README.md`, `README.txt` and dot-files are ignored). Keep the builder project file outside `workspace/` (this guide uses `design/` at the clone root).
4. **`pack.json` `id` must equal the builder's Id field.** The id is baked into `layout.json` twice: every CSS rule as `[data-pack="<id>"]`, every static locale key as `pack.<id>.`. A mismatch is refused by the dev loop (and would render unstyled, with labels reading `undefined`). The builder does not remember the Id between sessions, so type it before every export.
5. **A Refresh export never carries `pack.json` or `statusMenuLogic.cjs`.** It carries the layout, `layoutFormatters.cjs` and the shell. Bootstrap carries everything, so it only goes into an EMPTY `statusmenu/` and never over the template's.
6. **Actions never write.** An action returns a list of `{ op: 'set' | 'delete', path, value }`. MVU Helper applies it through MVU, and the card's Zod schema judges every change.
7. **One malformed change refuses the whole action.** A well-formed change the schema refuses is different: it does not land, the other changes do, and a warning lists its path. Write changes the schema accepts, and keep `[value, label]` pairs as pairs (`setPatch`).
8. **A click starts no turn.** The GameLogic Engine does not run after a menu click, so nothing is recalculated. An action returns every change its click means, derived values included.
9. **Formatters only read.** `(stat, root, scopePath) => value`, pure, no writes, return a string or a number.
10. **The menu runs in a locked frame.** Reading anything on `window.parent` or `window.top` throws, and a read outside a `try` kills the page at that line. `window.top.postMessage(...)` is the one thing a hand-written page may call on its parent.
11. **The menu engine runs in MVU Helper's Worker sandbox.** No DOM, no `window`, no network, no `require`, no `import()`, no timers. Both engine files join into one script in `engineOrder` order, so one top-level name declared in both files stops the engine from loading.
12. **A save is a deploy.** Every save under `workspace/` is installed on the open card within a second. Never leave a half-written file saved, and never put scratch scripts under `workspace/`.
13. **Bump `ENGINE_VERSION` in `statusMenuLogic.cjs` on every change.** It must stay a `const ENGINE_VERSION = '...'` string literal. It is reported and logged, never compared.
14. **`npm test` does not check the menu.** It only runs the EJS scope scan. The menu's checks run in the dev server on every save (see Verify).

## What the pack is

A StatusMenu Pack is the display half of a game, one per card. 3 parts:

| Part | Files | What MVU Helper does with it |
| --- | --- | --- |
| Layout (data) | `layout/layout.json` | Refuses it if it holds `customLogic` anywhere. Stores it whole in the silent entry `[StatusMenuPack:<id>] (Layout)`. The renderer in the shell reads it. |
| Engine (code) | `engine/layoutFormatters.cjs` + `engine/statusMenuLogic.cjs` | Joins them in `engineOrder` order into `[MVU_StatusMenuEngine]` and runs it in the Worker. Calls formatters, actions and inputs by name. |
| Shell (regex) | `regex/StatusMenu.json` | A regex whose replacement is the whole menu page. Install lifts the page into `[MVU_StatusMenuBody:StatusMenu]`, writes the regex back as an empty container, and mounts the page in a locked frame there. |

The shell's `find_regex` is `<StatusPlaceHolderImpl/>`. MVU appends that marker to a reply when it parses the reply's variable update, so the menu appears under replies. A greeting has to contain the marker itself (or, for School's start screen, `<GameStartMenu/>`).

A hand-written regex page (School's start screen) must keep the shape the lift needs: `<div class="mvu-helper-region" data-mvu-helper="<region>" ...>`, then `<!-- mvu-helper:begin <region> -->`, ONE code fence holding the page, `<!-- mvu-helper:end <region> -->`, `</div>`, and nothing else but comments. Install refuses anything else.

**What the locked frame may ask MVU Helper for:** formatter values, running an action, an action's inputs, one lorebook entry's text, a SillyTavern image (handed over as `blob:`), and opening an http(s) link right after a click. MVU Helper pushes `stat_data` to the frame on every change, so a menu never polls. A small prelude answers `getVariables`, `getCurrentMessageId`, `waitGlobalInitialized`, `Mvu.getMvuData`, `eventOn` with `Mvu.events.VARIABLE_UPDATE_ENDED`, `_.get`, `_.set`, an in-memory `localStorage`, and `MvuHelperFrame.lorebookContent(key)`.

## Folder and ownership

```
<clone>/
├── design/layout-<game>.json      builder project file (Export config). Outside workspace/
└── workspace/statusmenu/
    ├── pack.json
    ├── layout/layout.json
    ├── engine/layoutFormatters.cjs
    ├── engine/statusMenuLogic.cjs
    └── regex/StatusMenu.json, _GameStartMenu__.json, regex-order.json
```

| File | Written by | Hand edit |
| --- | --- | --- |
| `pack.json` | Bootstrap once, then you | yes |
| `layout/layout.json` | builder, every Refresh | NO |
| `engine/layoutFormatters.cjs` | builder, every Refresh. Declares one top-level name, `LAYOUT_FORMATTERS` | NO |
| `engine/statusMenuLogic.cjs` | Bootstrap once as a starter, then you | yes |
| `regex/StatusMenu.json` | builder, every Refresh | NO |
| `regex/_GameStartMenu__.json` | hand-written (School only) | yes, keep the lift shape |
| `regex/regex-order.json` | you. The dev loop also rewrites it when regexes are dragged into a new order in SillyTavern | yes |
| builder project file | builder Export config | yes, as JSON, then Import config |

The template ships the project file as `workspace/statusmenu/sample-layout-schoolv4.json`, a byte copy of School's. At that spot the dev server refuses the whole pack. Move it out first (Step 0).

## pack.json

ArtificKoi's: `{ "format": "1.0", "packType": "statusmenu", "id": "artifickoi", "name": "ArtificKoi", "description": "ArtificKoi", "version": "1.5", "builtWith": "MvuStatMenuBuilder 2.5.2", "engineOrder": ["layoutFormatters.cjs", "statusMenuLogic.cjs"], "targetsPackId": "school-v4" }`.

- `id`: lowercase kebab-case, frozen once published. It names the menu's CSS scope, locale keys and lorebook entries. `registry` is reserved.
- `version`: 2 or 3 whole numbers. Install compares it to tell an upgrade from a reinstall.
- `engineOrder`: exactly the files in `engine/`, generated file first. An unlisted file, or a listed missing one, is refused.
- `targetsPackId`: a label naming the GameLogic Pack, never checked. Set it to your `workspace/gamelogic/pack.json` id.
- `builtWith`: a receipt, never read.
- Refused here: `schema`, `state`, `exposes`, `requires`, `optionalUses`.

## The two-tool workflow

### Layout, cells, formulas, styling: MVU Status Menu Builder

The builder is a browser app. The user runs it, or the AI drives it through the Chrome MCP when the user opens it in the debug Chrome. Its downloads land in the browser's download folder.

| Builder control | Downloads | Goes where |
| --- | --- | --- |
| Data Configuration page > Config file card > Export config | the project file, named `layout.json` | rename to `design/layout-<game>.json`. NEVER into `layout/` |
| StatusMenu Pack page > Refresh workspace card > Download refresh .zip | `statusmenu-refresh.zip`: `layout/layout.json`, `engine/layoutFormatters.cjs`, `regex/StatusMenu.json` | extract INTO `workspace/statusmenu/`, any time |
| StatusMenu Pack page > Bootstrap workspace card > Download statusmenu.zip | `statusmenu.zip`: all of the above plus `pack.json` and a starter `statusMenuLogic.cjs` with NO actions | an empty `workspace/statusmenu/` only |
| Download `<id>-statusmenu-pack.json` | the single shipping file (starter engine, no actions) | not used in the workspace loop |

The Export HTML tab is a different output. It is not a StatusMenu Pack.

Layout change, every time:

1. Import config the project file (Data Configuration page > Config file card). It asks first, because it replaces the whole project. The project file is plain JSON: `layout` (the tabs), `mvuData` (sample `stat_data` as a JSON string), `selectedPaths`, `collectionPaths`, `lockedPaths`, `globalCss` (unscoped), `staticLocale` (unprefixed), `customTemplates`. The AI may edit it directly (for example, rewrite every `mappedKey`) before the user imports it.
2. Change the layout in the Builder tab. Cell formulas are the cells' `customLogic`, and they live only in the project file.
3. StatusMenu Pack tab: type Name and **Id = `pack.json` id**, tick every tab the menu shows (when some are ticked, only those export), read the "What the lift did" panel and the warnings.
4. Export config, and save over `design/layout-<game>.json`.
5. Download refresh .zip, extract into `workspace/statusmenu/`, overwrite the 3 files.
6. Verify (below).

On export, a formula that computes becomes a formatter in `layoutFormatters.cjs` and the cell keeps only `formatters: { text | image | lorebookKey: "<name>" }`. A formula that is a bare literal becomes the cell's `staticValue`. The name comes from the cell's `mappedKey` or title in camelCase (`Mainchar.Money` > `maincharMoney`, an Image cell adds `Image`), so renaming a `mappedKey` renames its formatter.

### Menu logic: `engine/statusMenuLogic.cjs`

Actions, inputs, game tables, `HAND_FORMATTERS`, `ENGINE_VERSION`. Edit, save, the dev loop reloads the engine. The builder never touches this file after Bootstrap.

## The engine contract

```js
const ENGINE_VERSION = 'v1.0';            // string literal, bump on every change
// helpers: isTuple, getRaw(obj, path, def), getV (value of a [value, label] pair), getL (its label),
// setPatch(root, path, value): a 'set' change that keeps an existing label
const HAND_FORMATTERS = {};               // + School's load-time check against LAYOUT_FORMATTERS
module.exports = {
    ENGINE_VERSION,
    formatters: { ...LAYOUT_FORMATTERS, ...HAND_FORMATTERS },
    actions: { /* name(args, root) => changes[] */ },
    inputs:  { /* actionName(args, root) => [{ name, kind, label, options }] */ },
};
```

**Formatters.** `stat` is the value at `scopePath`: the collection item a cell sits in (`Classmate.Mitsuki`), the object its block is mapped to, or the whole state outside every block. `root` is the whole `stat_data`. A builder formula runs inside that function with `stat`, `root`, `itemKey` (`Mitsuki`), `getV`, `getL`, `getRaw`, and assigns `_output`. ArtificKoi's Secret cell: `_output = (['Dating','Girlfriend','Friends_With_Benefits','Loyal_Puppy'].includes(getV(stat, 'RelationshipStage', ''))) ? getV(stat, 'Secret', '') : 'Hidden - reveals at Dating+';`. No `_`, no `el`, no DOM in a formula: it runs in the Worker. A formatter that throws or is missing leaves its cell showing the raw value. `HAND_FORMATTERS` is only reached by a cell whose `formatters` map names it, and the builder writes that map only from a formula, so put cell logic in the builder.

**Actions.** `(args, root) => changes[]`. `root` is a snapshot of the latest AI message's `stat_data`, and the changes land on that message, even when the click came from a menu under an older reply (formatters read the message their own menu sits on). `args` always carries `scopePath` (`''` at root). Who posts what:

| Click | Action name | `args` |
| --- | --- | --- |
| Checkbox cell | `setValue` (renderer built-in) | `{ path, value }` (boolean) |
| Portrait change | `setPortrait` (built-in) | `{ path, url }` |
| Row delete button (list with `allowDelete`) | `deleteListItem` (built-in) | `{ listPath, itemKey }` |
| Detail form save (list with `allowEdit`) | `editListItem` (built-in) | `{ listPath, itemKey, fields }`, every field a string |
| List `rowActions` entry (`{ title, action, args?, confirm? }`) | its `action` | cell `args` < entry `args` < `{ listPath, itemKey }`, plus the inputs' answers |
| Action Button cell (`action`, `args`) | its `action` | its static `args` |

`listPath` is the list's full path (`Classmate.Mitsuki.Belongings`). The dev server refuses a layout naming an action the engine does not export (rowActions, Action Buttons). It cannot see the 4 built-ins, so a missing `setValue` only shows as a refused click. The builder's starter engine has no actions. The template's `statusMenuLogic.cjs` has all 4 plus School's `equip`, `unequip`, `startGame`.

**Changes.** `{ op: 'set', path: 'A.B.C', value }` or `{ op: 'delete', path }`. Dotted path, no empty segment, no `__proto__`/`constructor`/`prototype`, `set` needs a `value`. `set` creates a missing member. A thrown `Error` refuses the action with its message, nothing written. An empty array writes nothing. A key may contain spaces or any script, never a dot. A field the Zod schema does not name is stripped on the next write ([schema](../gamelogic_engine/schema.md)).

**Inputs.** `(args, root) => [{ name, kind, label, options }]`, asked only for row actions (rowActions and the row delete), before the action runs. `kind` is `pick`, `number`, `text` or `boolean`. A `pick` with one option is answered without asking. `name` becomes the `args` key, and `scopePath` is reserved. No `inputs.<action>` means nothing is asked. An Action Button never asks.

## Adapting School's menu to a new game

Do the steps in order. Each ends with its check.

**Step 0: preflight.**
- The user runs `npm run dev`, the Artifact dev loop is on, the game's chat is open, and the pill reads Connected (or Updates only).
- Move `workspace/statusmenu/sample-layout-schoolv4.json` to `design/layout-schoolv4.json`. Check: `curl -s http://127.0.0.1:6620/workspace` shows `statusmenu` with an empty `errors` list (snippet in Verify).
- Read the new game's real shape: the Zod schema in `workspace/gamelogic/schema/`, and the live state through the Chrome MCP `evaluate_script` on the SillyTavern page: `JSON.stringify(Mvu.getMvuData({ type: 'message', message_id: 'latest' }).stat_data, null, 2)`. Save it as `design/stat_data-sample.json`.
- Expect School's menu on a non-School card to draw with empty or raw cells. Mismatch never breaks a card, it logs one warning per unresolved path.

**Step 1: identity.** Pick the id once (`my-game`). In `pack.json` set `id`, `name`, `description`, `version` (`"1.0"`), `targetsPackId`. The dev loop refuses the pack until Step 2's Refresh lands with the same Id. Under Not here, a new id is not installed on the card: Install to this card on its library row once. Check: `(await MvuHelper.packInfo()).types.statusmenu.installed` on the page names the new id.

**Step 2: layout (builder).** Load `design/layout-schoolv4.json`. Data Configuration: paste `design/stat_data-sample.json` into Raw JSON. Schema Output: tick the paths the menu shows, and tick Collection on every map of items (School's `Classmate`, `Mainchar.Inventory`). Builder: delete School-only tabs and cells, remap every `mappedKey` to the new paths, rewrite formulas that read School fields. A cell inside a block mapped to a collection uses `<Collection>.<Field>` without the item key (`Classmate.Name`). Replace School's image URLs (Profile link, school map). Global CSS: restyle as needed. Then steps 3 to 6 of the layout workflow, saving as `design/layout-<game>.json`. Check: `errors` empty, no `exports formatter "x" but no cell in the layout names it` warning, the menu redraws, the frame's text matches `stat_data` (Verify).

**Step 3: game tables in `statusMenuLogic.cjs`.** These are School's vocabulary:
- `LIST_FIELD_TYPES`: one row per editable list, keyed by path with the cast key wildcarded (`Classmate.*.Belongings`), naming non-string fields (`Qty: 'number'`). A list without a row cannot be edited from the menu (refused by name).
- `listPattern`: hard-codes `Classmate` as the cast root. Change it to the new cast root.
- `CARRIED_LEAF`, `INVENTORY_PATH`, `equip`, `unequip`, `inputs.equip`: School's carry model. Rewrite for the new game, or delete them together with the `rowActions` that name them (in the builder).
- Keep `setValue`, `setPortrait`, `deleteListItem`, `editListItem`. Add a new action for every new button.
- Bump `ENGINE_VERSION`.

Check: `errors` empty; each button clicked once in the menu; no `refused` or `did NOT take` line on the page console; `stat_data` after the click holds exactly the intended values.

**Step 4: the start screen.** `regex/_GameStartMenu__.json` (`<GameStartMenu/>`) posts `startGame` with `{ name, age, gender, race, stats: { Str, Sta, Int, Cha } }`, writes `Mainchar.*` pairs and raises `SaveInfo.GameStarted`. The page holds its own copy of the 200-point budget for live feedback, and `START_POINTS`, `START_STAT_MIN`, `START_STAT_MAX`, `START_STAT_LABEL` hold the copy the write is judged against. Adapt both, or delete the regex file, its name in `regex-order.json`, `startGame` and the `START_*` constants together. Check: `errors` empty (rule 14 names a mismatched `regex-order.json`). A regex save reloads the chat.

**Step 5: final pass.** Every tab opened, every list edited and deleted once, every row action and button clicked, a fresh reply played to see the menu mount under it. Pack `version` bumped if it ships.

## Verify

**Dev server judgment (every save).** Same checks as an import:

```
curl -s http://127.0.0.1:6620/workspace | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const a of JSON.parse(s).artifacts)console.log(a.name,JSON.stringify({errors:a.errors,warnings:a.warnings},null,1))})"
```

The `npm run dev` terminal prints the same as `✓ statusmenu [statusmenu "<id>"]` or `✗` plus each error. The pill: Connected after a good save, Not applied when the pack was skipped (the line names why).

**Page console** (Chrome MCP `list_console_messages` on the SillyTavern page): MVU Helper's menu lines start `[mvu-helper] [statusmenu-pack]`, the menu engine's own `MvuHelper.log` lines `[mvu-helper] [engine:statusmenu]`. Turn on the `pipeline` debug domain (Main tab) to also get `action "<name>" (<id>) landed N/M op(s)`.

**The frame.** The menu iframe sits in `[data-mvu-helper="statusmenu"]` inside the message and loads lazily, so scroll the message into view first. It is its own out-of-process CDP target (`type: "iframe"`, `url: "about:srcdoc"`), not an execution context of the page. Evaluate in it with a script kept outside `workspace/` (Node 22+):

```js
// frame-eval.mjs   usage: node frame-eval.mjs "document.title + ' | ' + document.body.textContent.slice(0, 3000)"
setTimeout(() => process.exit(2), 25000);
const targets = await (await fetch('http://localhost:9222/json/list')).json();
const page = targets.find((x) => x.type === 'page' && x.title === 'SillyTavern');
for (const t of targets.filter((x) => x.type === 'iframe' && x.url === 'about:srcdoc' && page && x.parentId === page.id)) {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    const reply = new Promise((resolve) => ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 1) resolve(m); }));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: process.argv[2], awaitPromise: true, returnByValue: true } }));
    console.log(t.id, JSON.stringify((await reply).result));
    ws.close();
}
process.exit(0);
```

Useful expressions: `document.title` (`StatusMenu`, or `Character Creation` for School's start screen), `document.body.innerText` (the open tab only), `JSON.stringify(getVariables().stat_data)` (what the frame was pushed). The frame logs `[MZSMB][pack] packs found=1 rendered=1` when the layout rendered, and `[MZSMB][action] "<name>" applied N op(s)` after a click. Those lines live in the frame target, so they can be missing from the page's console list.

**MVU state after an action:** `Mvu.getMvuData({ type: 'message', message_id: 'latest' }).stat_data` on the page. **What is installed:** `await MvuHelper.packInfo()`, read `disagreements` first.

## Symptom > cause > fix

| Symptom (where) | Cause | Fix |
| --- | --- | --- |
| `unexpected file at the artifact folder root: "sample-layout-schoolv4.json"` (dev server) | builder project file inside the artifact folder | move it to `design/` |
| `layout/layout.json scopes its CSS to pack "X" but pack.json declares "Y"` (and the same for static locale) | builder Id differs from `pack.json` id | type Id = `pack.json` id, Refresh again |
| `rule 6: layout carries "customLogic"` | the project file (also downloads as `layout.json`) was dropped into `layout/` | extract `layout/layout.json` from a Refresh zip, keep the project file in `design/` |
| `the layout names formatter "x" ... but the engine beside it does not export it` | `layout.json` and `layoutFormatters.cjs` from different exports, or the `...LAYOUT_FORMATTERS` spread removed | extract all 3 files from one Refresh, keep `formatters: { ...LAYOUT_FORMATTERS, ...HAND_FORMATTERS }` |
| `the layout names action "x" ... does not export it` | a rowActions entry or Action Button without an action | add `actions.x`, or fix the name in the builder |
| `the StatusMenu Engine failed to load: formatter "x" is written by hand ... AND computed by the layout` | a `HAND_FORMATTERS` name equals a generated one | rename the hand one |
| `the StatusMenu Engine failed to load: ... has already been declared` | one top-level name in both engine files | rename it, or move it inside a function |
| `rule 3: the "engine" text declares no version` | `ENGINE_VERSION` removed or not a string literal | restore `const ENGINE_VERSION = 'v1.0';` |
| `engine/x.cjs is not named in engineOrder` | new engine file | add it to `engineOrder` after `layoutFormatters.cjs` |
| `rule 14: regex "..." is not named in regexOrder` / `regexOrder names "..."` | `regex-order.json` out of sync with `regex/` | list every regex `script_name` exactly once |
| click refused, page console `"<id>" exports no action "setValue" (it has: ...)` | a built-in action missing (starter engine) | add `setValue`, `setPortrait`, `deleteListItem`, `editListItem` |
| `action "x" (<id>) REFUSED` + `patch[i] ...` | malformed change | fix op, path or value |
| `action "x" (<id>): N op(s) did NOT take` + paths; frame `REFUSED by the card schema` | the schema refused those values, the rest landed | `setPatch` for pairs, match the schema's type, add the field to the schema |
| `action "x" (<id>) failed inside the engine`, then the Error's message | the action threw (a refusal or a bug) | read the message |
| a derived value stays stale after a click | a click starts no turn | return the derived value from the same action |
| cell shows the raw value; `formatter "x" threw for cell` or `formatter pre-pass: ... did not answer` | the formula throws or reads a missing path | fix the formula in the builder, Refresh |
| no menu under a reply | no `<StatusPlaceHolderImpl/>` in the message (MVU did not parse an update; a greeting lacks it), or the frame not scrolled into view | check the raw message text, scroll it into view |
| `[frame] "<row>" of "<id>" on message N threw: ...SecurityError` | a hand-written page reads `window.parent`/`top` | read `getVariables()`, write through `window.top.postMessage`, guard reads in `try` |
| menu unstyled, labels `undefined` (single-file import) | id mismatch in an older export | re-export with matching Id |
| new builder option has no effect (for example a read-only checkbox stays clickable) | an older shell in `regex/StatusMenu.json` | Refresh again and extract the shell too |
| pill Updates only after an id change | under Not here, a new id is not installed | Install to this card on the library row |

## Done checklist

- [ ] `workspace/statusmenu/` holds only `pack.json`, `engine/`, `layout/`, `regex/`. The project file is in `design/` and matches the last export.
- [ ] `pack.json` id equals the builder Id. `version` is 2 or 3 whole numbers. `targetsPackId` names the GameLogic Pack.
- [ ] `layout.json`, `layoutFormatters.cjs` and `StatusMenu.json` came from one Refresh export, unedited.
- [ ] Dev server: `statusmenu` has no errors and no warnings. Pill: Connected.
- [ ] Frame: `[MZSMB][pack] packs found=1 rendered=1`. Every tab's text matches `stat_data`. No raw values where a formula was meant.
- [ ] Every button, row action, checkbox, edit and delete clicked once. No `refused` / `did NOT take` line. `stat_data` after each holds exactly the intended values, derived values included.
- [ ] No School vocabulary left in `statusMenuLogic.cjs` (`Classmate`, `Mainchar`, `Belongings`, `START_*`) unless the new game uses it.
- [ ] `ENGINE_VERSION` bumped. `npm test` passes (it checks the workspace's EJS, not the menu).
- [ ] The user reviews the diff before any commit.

[Back to QuickStart Guide](../quickstart.md)
