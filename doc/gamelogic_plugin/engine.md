# The plugin engine

> A plugin is written for any game. ArtificKoi shows up as a real host, not as a rule. See [Written for any game](technical.md#written-for-any-game).

A plugin's engine is a small JavaScript file with one main job, `resolveRelay`. It runs once every reply, after the game is done with it, reads what the reply actually did, and hands back changes.

It takes the model out of the bookkeeping. A resolver can't be declined, reworded or crowded out by another block in the prompt. It just runs.

```js
const ENGINE_VERSION = 'v1.0.0';     // a plain string, exported. Logged, never compared

module.exports = {
  ENGINE_VERSION,
  resolveRelay({ ownState, snapshot, ops, dice, dicePools, exposes, engine, roster, ownRoot, ownPointer, pluginVersion, mid, swipe }) {
    return {
      patches: [                                                    // full JSON Pointer paths
        { op: 'add', path: ownPointer + '/Turn', value: (ownState.Turn || 0) + 1 },
      ],
      log: ['turn recorded'],                                       // MVU Helper prints these
    };
  },
};
```

The engine goes in the file's `engine` section: one JavaScript text, or several files joined in the order `engineOrder` lists them. Install keeps it on the card, in a hidden `[GameLogicPlugin:<id>:Engine]` entry, so it keeps working after the library copy is deleted.

## When it runs

`resolveRelay` runs **once per reply, after the reply's last write**, in that same reply, on every card:

- **POST wrote a block.** It runs when that block is applied. On a card whose game engine exports `resolvePostRelay`, it runs right after it. Your writes are saved together with POST's.
- **POST wrote nothing, or no POST call ran.** No call set up, Extra LLM Calls off, or a call that failed. Then it runs once the reply's own update is done, the game's RES1 included, and everything after the reply has finished.

A quiet reply is still a reply. Record that nothing came, instead of skipping it.

MVU Helper keeps the once-per-reply guard, not you. A regenerate is a new reply, so it runs again. A reply the player stops in the middle isn't recorded, and your resolver doesn't run for it. And when the next generation starts before your writes are saved, they're dropped instead of landing in the wrong reply. Why all of this matters is on [Same reply protection](../gamelogic_engine/same_reply.md#and-only-once).

## What it receives

- **`ownState`** > your drawer. It's a copy, so changing it changes nothing. Return patches instead.
- **`snapshot`** > all of `stat_data`, also a copy, to read the game and other plugins.
- **`ops`** > every change the reply actually applied, as `[{ path, old, new, by }]`, with dotted paths.
- **`dice`** > every die dealt this generation, in one flat list. **`dicePools`** > the same dice per pool, `{ pool, sides, dice }` or `{ hash, sides, dice }`.
- **`exposes`** > your declared interfaces, matched to this game's paths: `{ "cast@1": "Classmate" }`. `{}` when nothing matched.
- **`engine`** > the game engine's identity, `{ name, type, version, packId }`. Every field is `null` when unknown.
- **`roster`** > every installed plugin's id, and its drawer. The player picks drawer names, so you can't guess them.
- **`ownRoot`** and **`ownPointer`** > your drawer as a dotted path and as a JSON Pointer.
- **`pluginVersion`**, **`mid`**, **`swipe`** > your plugin's version, and which message and swipe this is.

`exposes` and `engine` are on [Running on any game](any_game.md).

### `ops`: what the reply actually did

This is what a resolver can do that no prompt can. "Did the narrator actually change the population?" is answered by an op, with zero LLM calls.

- Only ops that applied show up. A refused op never does.
- Several writes to one path in one update show up as one.
- An array shows up whole.

`by` says who made the change:

| `by` | Who |
| --- | --- |
| `message` | the reply's own `<UpdateVariable>` block |
| `pre-sim` | a PRE call's patch |
| `post` | POST's block |
| `plugin:<id>` | a plugin's resolver. Your own earlier writes come back with your id |
| `statusmenu:<id>` | a status menu button |
| `host` | any other part of MVU Helper |

### Dice: check, never roll

Check a die the prose reports against the pool it came from. In the flat `dice` list, a d6's 4 passes as a d20's 4, so look it up in `dicePools`.

Both are `null` when nothing was dealt. Then there's nothing to check. It's not permission to roll.

**A resolver never rolls.** The deal happens in your entry, while the prompt is built. A die rolled after the model is done is a die the model never saw. `crypto` is there in the sandbox for randomness no prose ever reports.

## What it returns

**`patches`** are normal JSON Patch ops, `add`, `replace` or `remove`, with full JSON Pointer paths. Build them from `ownPointer` for your drawer.

MVU Helper checks each op's shape, and hands them all to `Mvu.parseMessage` in one `<UpdateVariable>` block. So the card's Zod schema judges your ops like anyone else's:

- A broken op, one whose value isn't JSON, or one whose path goes through `__proto__`, `constructor` or `prototype`, is dropped alone. The others still go.
- An op can be **refused**, and the receipt says so. The console line reads `[RES2] plugin <mid:swipe>: "<id>" landed N/M op(s) (K refused)`. A warning lists every op that didn't take, with what was sent and what is stored now: `landed`, `coerced`, `changed`, `refused` or `absent`.

So don't assume a write landed.

**`log`** > lines MVU Helper prints as `[mvu-helper] [gamelogic-plugin] "<id>": …`, in the pipeline debug domain. For your own lines while it runs, use `MvuHelper.log`. See [Logging](entries.md#logging).

**If it throws,** the error is logged with your plugin's name, your patches are dropped, and the reply carries on. The game and every other plugin included.

A broken engine file is the same. Its error shows up when it loads, and every other engine still starts.

## Where it runs

Your engine runs in the same Worker as the game engine, inside a hidden frame. No DOM, no network, no `import()`.

It sees the JavaScript language, plus `console`, `crypto`, `structuredClone`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, and `MvuHelper`:

- `MvuHelper.engineInfo()` > the game's identity,
- `MvuHelper.log` > the logger,
- `MvuHelper.messages` > the chat's messages as index, role and swipe, with no text.

Each engine file runs in its own scope, with its own private globals. A `window.X` set by one is invisible to every other. And a plugin can't call the game engine's functions.

So plugins and the game only talk through data (the snapshot) and through prompts. It's like flats in one building. Everyone gets the same water and power, but nobody walks into the next flat.

Every call crosses into the sandbox as a copy, so arguments and results are copies too. The full story is in the Security point of the [README](../../README.md).

## `renderPanel` and the side panel slot

A plugin with a `panel` gets one slot in MVU Helper's side panel, the drawer behind the arrow at the chat's right edge. It sits next to the game's slot and every other plugin's. No `panel`, no slot. How the side panel works is on [Side Panel](../side_panel/README.md).

- **In the folder it's `panel/panel.json`.** Install keeps it in a hidden `[GameLogicPlugin:<id>:Panel]` entry, uninstall removes it, and the dev loop re-applies it on every save.
- **A bare path reads from YOUR drawer,** so it works whatever name the player picked. That's the one difference from a GameLogic Pack's panel, where a bare path reads from the top of `stat_data`.
- **Outside your drawer,** `{cast@1}.…` reads through an interface you declared. `$.World.Time` is a raw read from the top, for when you know the card's layout and say so.
- **Bind your own drawer for everything that has to show on any card.** On a card with no game, an interface path shows the "missing" marker. That's honest, but useless as the only thing in your slot.

Instead of binding fields, your engine can also export `renderPanel(ctx)` and work out the slot itself. Its `ctx` is the read side of `resolveRelay`, without the reply fields: `{ ownState, snapshot, engine, exposes }`.

[Back to How a GameLogic Plugin works](technical.md) · [Back to index](../../README.md)
