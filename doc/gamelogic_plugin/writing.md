# Writing into stat_data

> A plugin is written for any game. ArtificKoi shows up as a real host, not as a rule. See [Written for any game](technical.md#written-for-any-game).

A plugin owns exactly one spot in `stat_data`, its drawer: `GameLogicPlugin.<name>`, with the name the player picked at install. Nothing else writes there.

`{OWN_ROOT}` gives your entries the drawer as a dotted path, like `GameLogicPlugin.Weather`. Your resolver gets it as `ownRoot`, and as a JSON Pointer, `ownPointer`, like `/GameLogicPlugin/Weather`.

## Your drawer

MVU Helper creates your drawer, empty, at install, on every chat load, and on the 2 messages a new generation can start from. You create whatever you keep inside it, whenever you start keeping it.

**The drawer is your registration.** A write into a missing drawer still lands, and creates the containers on its way. That rebuilds a drawer MVU Helper never registered. So write only when your drawer is there, and say so in your log when it isn't.

## Writing outside your drawer

Owning a drawer means nothing else writes there. It's not a fence around you. An installed plugin can read all of `stat_data`, and write any path the card's Zod schema allows. Installing a plugin is the player's decision to trust it.

Whether you *should* write a game's path is the game's call. Most of the time, you shouldn't:

- A value you write into a game's own state skips the game's rules. The game may overwrite it on the next reply, or carry on from a state no rule of its own produced.
- A write into a game's report channels reads to the game as something the reply did. The game resolves it as if its narrator had sent it.

When your plugin wants the game to change, say so in prose, in a narrate entry, and let the narrator report what happened on the game's own channels. A game's house rules for plugins are its own. ArtificKoi's are on [A real host: ArtificKoi](artifickoi.md#its-house-rules-for-writing).

## The 4 lanes

| Lane | What you ask for | What judges it |
| --- | --- | --- |
| a request in prose (a narrate entry or PRE's output) | the narrator must understand a request and act on it in the story | the game's own rules, then Zod |
| a PRE `<JSONPatch>` block | the PRE model copies a block you printed | Zod |
| a POST `<UpdateVariable>` block | the POST model copies a block you printed | Zod |
| `resolveRelay` | nothing, your code runs | Zod |

**The patch lanes aren't best effort.** Once a block is in the output, the rest is MVU Helper's code. It takes out every block, saves what it can op by op, applies it through `Mvu.parseMessage`, the same call the game's own systems use, and saves the result. So the only question is whether the model writes the block. Copying a printed block is a simple, mechanical job.

**The prose lane is the soft one.** It needs the narrator to understand you.

**The relay lane involves no model at all.** It can't be declined, reworded or crowded out, and it reads what the reply actually did. Its ops go through the same `Mvu.parseMessage`, reach the same paths, and are refused by the same Zod.

So put anything that has to be exact in `resolveRelay`. Use the patch lanes when a model's judgment is the input. Use prose only for what has to read as story.

## The schema

Something has to declare `GameLogicPlugin` open in the card's Zod schema, or every key you create is stripped or refused. That's your `schema/` file. It has one line that matters:

```js
// one root, open. Yours declares this and nothing else
GameLogicPlugin: z.record(z.string(), z.any()).prefault({}),
```

Keep the schema's own root open too, so every other root passes through untouched: `z.looseObject({...})`, or a `z.object({...})` opened with `.passthrough()` or `.catchall(z.any())`. A plugin schema with a closed root is refused. A plugin declares only one root, so a closed one would strip the entire game.

- **Don't name a game's roots in it.** That's what breaks the next card you install on.
- **Don't count on MVU's Zod helper to reopen a closed root.** It only reopens a root that's a plain `z.object`, and `.prefault({})` makes it something else.
- **It can only declare.** Anything off the allowlist is removed before it installs. See [It can only declare a schema](../gamelogic_engine/schema.md#it-can-only-declare-a-schema).

### Whether your schema gets written

Install decides that per card:

| The card has | Install | The success message says |
| --- | --- | --- |
| no schema at all | writes yours. Without it, MVU freezes your empty drawer | `added its schema (the card had none)` |
| a schema its GameLogic Pack installed | skips yours. The game already declares the root open, and replacing its schema would drop every path the game declares | nothing |
| exactly your schema | skips | nothing |
| the schema your plugin wrote earlier | replaces it with this version | `updated its own schema` |
| a schema from anywhere else (the card itself, another plugin) | **asks**, "Replace this card's own copies?". **Replace** puts yours in, and the card's own rules go. **Keep the card's schema** keeps the card's, and installs without yours. The answer is recorded, so an upgrade or the dev loop never asks again | `replaced the card's schema` / `kept the card's schema` |

Nothing is written to the card until that question is answered.

So on a card with a game, the game's schema is the one that judges your writes. Yours only matters on a card with none.

**A card can lose its schema under you.** Uninstalling a GameLogic Pack removes the schema it owned, and yours was skipped because the pack's was there. From then on MVU refuses every new key in your drawer. Your plugin's row then says the card has no schema and offers Repair. Repair runs the decision again, finds a card with no schema, and writes yours.

## What MVU will and won't let you write

### 2 kinds of card

Which way your writes are applied depends on the card:

- **A card with a Zod schema running.** Each op is applied on a copy, and the whole result is checked. Missing containers are created for you, and depth is free.
- **A card with no Zod schema.** That's a normal kind of card, and standalone plugins exist for it. MVU applies ops with plain JSON Patch, which refuses an `add` deep inside a parent that doesn't exist: `Cannot assign into path '…' because it holds a primitive value (undefined). The operation was skipped. (json_patch)`.

### Write shapes that land on both

- **Create every parent yourself, in the same patch.** Ops apply in order inside one patch, so a first op makes the parent real for every op after it:
  ```jsonc
  {"op":"add", "path":"<own>/Characters",       "value": {}}                       // ONLY when the previous state lacks it
  {"op":"add", "path":"<own>/Characters/Mira",  "value": {"Outfit":"…","At":"2:0"}} // one object-valued op per child
  ```
  Only send that first op when your previous state doesn't have the container. `add` sets the value, so an `add` of `{}` on a container that's already there wipes it.
- **One op per child, with the whole object.** Not one op per field.
- **`replace` on a `[value, label]` pair's slot. `add` only for keys you create in your own drawer.**

| Op | Zod card | plain card |
| --- | --- | --- |
| deep `add`, parents missing | applies, parents created | **refused**, warned by name |
| `add` at a `[value, "Label"]` index | inserts, so the pair has the wrong length, and the op is **reverted without a word** | **inserts**. The pair is now 3 long, and stays that way |
| `add` a new key on a closed or frozen root | refused by the schema | it depends. Don't build on it |
| a plain value set over a `[value, "Label"]` field | judged by the schema's shape | **squeezed** into slot 0 |
| a string where a number was | judged by the schema's shape | **turned into a number** with `Number()` |

### The pair trap

MVU stores a lot of fields as `[value, "Label"]`. A JSON Patch `add` at an index **inserts**. A `replace` at the same path with the same value works on both kinds of card:

```jsonc
{"op":"add",     "path":"/World/Weather/0", "value":"Storm"}   // Zod card: reverted. Plain card: ["Storm","Clear","Weather"] stays
{"op":"replace", "path":"/World/Weather/0", "value":"Storm"}   // works on both: ["Storm","Weather"]
```

`/-` appends to a pair too, so only use `/-` on lists you own.

One refused op doesn't throw away the others in its block. So an op you expect might fail is safe next to real writes.

Before you design around any of this, test the op on a copy, on the kind of card you target: `Mvu.parseMessage(block, structuredClone(vars))` answers in one call, and never touches a save.

### When your writes vanish

The error text says who refused them:

| Error text | Who refused | What it means |
| --- | --- | --- |
| `✖ Too big` / `路径:` … | the card's Zod schema | your op broke a shape the schema declares |
| `Cannot assign into path '…' because it holds a primitive value (undefined) … (json_patch)` | MVU, plain card | your op assumed a parent. Create it yourself. The card is fine |
| `SCHEMA VIOLATION: Cannot assign the new key … non-extensible object` `(json_patch)` | MVU, plain card | a frozen root. On a card that SHOULD have Zod, its `Scheme` script isn't running. Fix that, not your plugin |

## Hand the model a finished op

Every value a model has to build is a value it can get wrong. And the POST call doesn't always see your drawer. So work the op out in EJS, and leave the model nothing to do but decide whether to send it:

```ejs
<%_
const _jrRoot = '{OWN_ROOT}';                             // "GameLogicPlugin.Journal"
const _jrPath = '/' + _jrRoot.split('.').join('/');       // "/GameLogicPlugin/Journal", JSON Patch wants slashes
let _jrLog = [], _jrTurn = 0;
try {
    let mine = getvar('stat_data') || {};
    for (const seg of _jrRoot.split('.')) mine = (mine && typeof mine === 'object') ? mine[seg] : undefined;
    mine = mine || {};
    _jrLog = Array.isArray(mine.Log) ? mine.Log.slice() : [];
    _jrTurn = Number(mine.Turn) || 0;
} catch (e) {}
_%>
# Send BOTH ops, copied EXACTLY. Don't recompute the numbers:
#   { "op": "add", "path": "<%= _jrPath %>/Log",  "value": <%- JSON.stringify(_jrLog.concat(['<the line you record>'])) %> }
#   { "op": "add", "path": "<%= _jrPath %>/Turn", "value": <%= _jrTurn + 1 %> }
```

Building the slash path from the dotted one means the instructions always name the drawer the player picked.

## Count only once

A reply can run your POST entry more than once, and nothing in front of it removes the duplicate ops. So an entry that counts has to guard itself.

Guard on something that stays the same for the whole generation. `rollPool` deals once per generation, so a second pass sees the same die. Record that die with your count, and when the die you see is the one already recorded, print a "record nothing" branch instead.

If your guard depends on something that can be missing, say so for that reply. Don't quietly guard on something else.

Your `resolveRelay` doesn't need this. MVU Helper makes sure it runs once per reply. See [When it runs](engine.md#when-it-runs).

## Strict games

A game's own POST instructions may forbid ops outside its paths. A well-behaved POST model then ignores yours. 3 ways out:

- bind your POST entry to a call of its own,
- ask the game's author to allow plugin drawers,
- or use `resolveRelay`, which involves no model at all.

[Back to How a GameLogic Plugin works](technical.md) · [Back to index](../../README.md)
