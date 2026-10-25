# State corrections

> This page applies to any game. ArtificKoi shows up as a real example, not as a rule. See [A general design, with one real example](technical.md#a-general-design-with-one-real-example).

`state` fixes values in saves that already exist. Players keep playing while you ship new versions, and sometimes an old save holds a value your new version can't live with.

## Where it goes

`state` goes in your pack's `pack.json`, next to `id` and `version`. No folder makes it, so you type it right in:

```json
{
  "format": "1.0",
  "packType": "gamelogic",
  "id": "my-game",
  "name": "My Game",
  "description": "A game that resolves its turns.",
  "version": "1.2.0",
  "engineOrder": ["gameLogic.cjs"],
  "state": {
    "version": "1.2.0",
    "force": { "World.Weather": ["Clear", "Weather"] },
    "forceFromInitVar": ["EventPack.triggers"]
  }
}
```

## The seed is not here

Your card's starting state is its `[InitVar]` entry, not `state`. It's an ordinary entry in `entries/`. ArtificKoi's is `entries/config/initvar_mvu_init.txt` (the starting `stat_data` as JSON) plus `initvar_mvu_init.json`, with the comment `[InitVar] MVU Init`. See [Entries](entries.md#the-seed).

MVU Helper re-applies `[InitVar]` on every chat load. It only fills in what's missing, at any depth, and never overwrites.

So adding a new field is easy. Put it in `[InitVar]`, and every old save gets it on the next load. Changing a value is different: an old save keeps the value it already has. That's what the two lists below are for.

## forceFromInitVar pushes what you changed

`forceFromInitVar` is a list of paths. For each one, MVU Helper takes the value your `[InitVar]` has there and writes it over the save's.

Use it for things you define, not things the player earns. Your event table is the classic case. Say version 1.1 opened an event on April 16, and 1.2 moves it to April 17. You edit `[InitVar]`, list `EventPack.triggers`, and bump `state.version`. Every old save gets the new date on its next load.

You keep one copy. The value lives in `[InitVar]`, and the list only says where it goes.

A table goes row by row. Each row your `[InitVar]` has replaces the save's row with the same key. A row your `[InitVar]` doesn't have stays, because a player may have installed an event pack from another developer into the same table. Nothing is ever deleted.

Empty fields don't count as a change. Your schema fills in a field a row leaves out (`check: ""`, say), so the save's row can have it while yours doesn't. That row is still yours, and it isn't rewritten.

List the table itself, never what holds it. `EventPack` would push `EventPack.fired` too, and every event the player already saw would come back.

A path your `[InitVar]` doesn't have is refused, and the console says which one.

## force fixes what's wrong

`force` is for values that are already there, and wrong. It's a flat map: dotted path > the value to write.

It's a game patch. The patch fixes your existing save files once, and then leaves them alone.

Say version 1.1 had a bug, and every new game started with the weather stuck on "Storm". You fix `[InitVar]` in 1.2. New games are fine, but old saves still say "Storm", and `[InitVar]` won't overwrite a value that's already there. So 1.2 ships the `force` above, with `state.version` set to `"1.2.0"`. Every old save gets "Clear" once, on its next load.

Watch out for one thing. `force` doesn't check whether the value is actually wrong. It writes its value once per save, whatever is there, even a value the story changed on purpose. Use it only for values that should never have been what they are.

When both lists name the same path, `force` runs second, so its value wins.

## The version

`state.version` is required whenever `state` is there. Same shape as the pack's `version`, like `"1.2.0"`.

Each list runs once per save, when `state.version` is newer than the version that save last took for that list. After that, it never touches that save again. To push again, bump the version.

The two lists keep separate records. A save that took 1.2 under an older MVU Helper, one that didn't know `forceFromInitVar` yet, still gets the push once MVU Helper is updated. A pack that older MVU Helper installed needs one reinstall first, because that install didn't record the list.

It reaches the 2 newest saved messages, the ones the next reply or a regenerate starts from. A player who deletes back past them is on a state from before the push, and that save won't take the same version again.

The console shows each list on every chat load: `force from [InitVar]: EventPack.triggers 163 of 218 rows replaced (…)` the first time, then `version 0.2.0 <= pushed 0.2.0` for the push once the save has it.

ArtificKoi lists `EventPack.triggers` in `forceFromInitVar` at `state.version` `"0.2.0"`, and ships `"force": {}`. A test in its repo fails when the event table changes and `state.version` doesn't.

[Back to How a GameLogic Engine works](technical.md) · [Back to index](../../README.md)
