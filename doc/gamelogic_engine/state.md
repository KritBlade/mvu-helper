# State corrections

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
  "state": { "version": "1.2.0", "force": { "World.Weather": ["Clear", "Weather"] } }
}
```

## The seed is not here

Your card's starting state is its `[InitVar]` entry, not `state`. It's an ordinary entry in `entries/`. ArtificKoi's is `entries/config/initvar_mvu_init.txt` (the starting `stat_data` as JSON) plus `initvar_mvu_init.json`, with the comment `[InitVar] MVU Init`. See [Entries](entries.md#the-seed).

MVU Helper re-applies `[InitVar]` on every chat load. It only fills in what's missing, at any depth, and never overwrites.

So adding a new field is easy. Put it in `[InitVar]`, and every old save gets it on the next load.

## force fixes what's wrong

`force` is for values that are already there, and wrong. It's a flat map: dotted path > the value to write.

It's applied once per save, when `state.version` is newer than the version that save last took. After that, it never touches that save again.

It's a game patch. The patch fixes your existing save files once, and then leaves them alone.

Say version 1.1 had a bug, and every new game started with the weather stuck on "Storm". You fix `[InitVar]` in 1.2. New games are fine, but old saves still say "Storm", and `[InitVar]` won't overwrite a value that's already there. So 1.2 ships the `force` above, with `state.version` set to `"1.2.0"`. Every old save gets "Clear" once, on its next load.

Watch out for one thing. `force` doesn't check whether the value is actually wrong. It writes its value once per save, whatever is there, even a value the story changed on purpose. Use it only for values that should never have been what they are.

## The version

`state.version` is required whenever `state` is there. Same shape as the pack's `version`, like `"1.2.0"`.

ArtificKoi ships `"force": {}` right now. Nothing to fix.

[Back to How a GameLogic Engine works](technical.md) · [Back to index](../../README.md)
