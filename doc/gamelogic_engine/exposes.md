# Exposes

`exposes` tells plugins where things live in your game.

A plugin is written once and should work on many games. But every game names its things differently. Your cast might live in `Classmate`, another game's in `Party`. `exposes` is the translation.

It's like a mall directory. Every shopper asks for "restrooms", and every mall's directory points somewhere different.

## Where it goes

`exposes` goes in your pack's `pack.json`, next to `id` and `version`. No folder makes it, so you type it right in. Here's the part of ArtificKoi's `pack.json` that carries it:

```json
{
  "id": "school-v4",
  "version": "5.127.2",
  "exposes": { "cast@1": "Classmate", "player@1": "Mainchar" }
}
```

The whole file is on [What's in a GameLogic Pack](pack.md#artifickois-packjson).

## The format

Interface name > your own dotted `stat_data` path. That's ArtificKoi's, so a plugin asking for `cast@1` gets `Classmate`.

An interface name is `<name>@<major>`, lowercase, like `cast@1`.

## How a plugin uses it

The plugin says what it needs:

- **`requires`** > the plugin is useless without it. If your game doesn't expose it, the install is refused, and the message names the interface.
- **`optionalUses`** > the plugin can still do something useful without it. It installs, and says it runs without it.

MVU Helper matches the names and hands the plugin your path. It never checks what's actually at that path. If you expose the wrong path, the plugin reads nothing.

The install records your map on the card, so it still works after the library copy is deleted.

## The interfaces

| Interface | What a game promises | What a plugin does with it |
| --- | --- | --- |
| `cast@1` | a map of id > object with at least `Name` | the recurring people: classmates, party, partners |
| `player@1` | an object with at least `Name` | who the story is about |
| `places@1` | a map of id > object with at least `Label` | maps, travel, "have I been here" |
| `chronicle@1` | a map of id > object with at least `summary` | recaps and memory |
| `clock@1` | an object with at least a day counter | anything scheduled: cooldowns, deadlines, "next week" |
| `locale@1` | a language tag | the plugin translates its own output |

`cast@1` and `player@1` are published today, by ArtificKoi. The other 4 are proposed. Nothing publishes them yet, so a plugin that `requires` one is refused everywhere for now.

## Rules

- **A name promises a shape, never a place.** You can move your cast to a new root tomorrow by changing one line in `exposes`, and every plugin keeps working. Changing the shape breaks every plugin, so a new shape gets a new name, `cast@2`, published next to `cast@1` until plugins move over.
- **Don't expose your report channels** (ArtificKoi's `Intent`). That hands plugins a way to write into your game by accident.
- **Don't expose mid-turn handoff slots** (ArtificKoi's `PendingState`), where one part sets a value and another clears it.

How plugins are written is on [What is GameLogic Plugin](../gamelogic_plugin/README.md).

[Back to How a GameLogic Engine works](technical.md) · [Back to index](../../README.md)
