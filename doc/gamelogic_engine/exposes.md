# Exposes

> This page applies to any game. ArtificKoi shows up as a real example, not as a rule. See [A general design, with one real example](technical.md#a-general-design-with-one-real-example).

`exposes` tells plugins where things live in your game.

A plugin is written once and should work on many games. But every game names its things differently. Your cast might live in `Classmate`, another game's in `Party`. `exposes` is the translation.

It's like a mall directory. Every shopper asks for "restrooms", and every mall's directory points somewhere different.

## Where it goes

`exposes` goes in your pack's `pack.json`, next to `id` and `version`. No folder makes it, so you type it right in. Here's the part of ArtificKoi's `pack.json` that carries it:

```json
{
  "id": "school-v4",
  "version": "5.132.0",
  "exposes": {
    "cast@1": "Classmate",
    "player@1": "Mainchar",
    "location@1": "World.Location",
    "landmarks@1": "WorldRecord.Locations",
    "chronicle@1": "WorldRecord.Events",
    "clock@1": "World"
  }
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
| `location@1` | the id of the place the scene is in now | "where are we", travel |
| `landmarks@1` | a map of id > object with at least `Label`. An id is the same string `location@1` holds while the scene is there | the places the game has named: a map of them, a travel menu |
| `chronicle@1` | a map of id > object with at least `summary` | recaps and memory |
| `clock@1` | an object with at least `Date` (`yyyy-mm-dd`) and `Time` (`HH:MM`) | anything scheduled: cooldowns, deadlines, "next week" |
| `locale@1` | a language tag | the plugin translates its own output |

ArtificKoi publishes the first 6, as in the `pack.json` above. `locale@1` is proposed. Nothing publishes it yet, so a plugin that `requires` it is refused everywhere for now.

What a plugin has to know:

- **`landmarks@1` isn't every place in the world.** A game can list only the places found during play, so the scene can be somewhere with no landmark. No landmark means no label, not nowhere. ArtificKoi keeps its base map in a lorebook entry, so there it happens a lot.
- **A value can come as MVU's `[value, description]` pair.** Read the first item when it's a pair: `Array.isArray(v) ? v[0] : v`. ArtificKoi writes every value that way: `Name` is `["Mitsuki Tachibana", "Name"]`, and `World.Location` is `["Town_BusStop", "Location"]`.
- **Time doesn't only move forward, and records don't always stay.** A game can rewind its clock or delete old records, so a cooldown counted by date difference can go negative. Check for that instead of trusting it. ArtificKoi does both: a time leap resets the date to `2026-04-08` and deletes the chronicle entries that aren't kept across it, and the player can trim the log too.

## Rules for exposing

- **A name promises a shape, never a place.** You can move your cast to a new root tomorrow by changing one line in `exposes`, and every plugin keeps working. Changing the shape breaks every plugin, so a new shape gets a new name, `cast@2`, published next to `cast@1` until plugins move over.
- **Don't expose your report channels** (ArtificKoi's `Intent`). That invites plugins to write your game's reports, as if your narrator had sent them.
- **Don't expose mid-turn handoff slots** (ArtificKoi's `PendingState`), where one part sets a value and another clears it. Read at the wrong moment, the value means nothing.
- **Don't expose what already has its own contract,** like Event Pack paths. 2 ways of carrying one fact drift apart.

## Adding a new name

The 7 names above are the whole list today. When your game has something no name covers, a new name is added to the list. These are the rules for one:

1. **Name the idea, not your word for it.** `cast@1`, never `classmate@1`.
2. **Promise the minimum.** Every field you put in the shape is a field the next game has to produce too.
3. **Publish a place you can keep publishing.** The path can move. The name can't disappear.
4. **Don't publish what can't be used blind.** If a plugin needs your design notes to understand the value, it isn't an interface. That plugin should check `ENGINE_NAME` and handle your game by name instead.

## Exposing is not permission

`exposes` answers "where is it", never "may I write here".

An installed plugin can read all of `stat_data`, and it can write any path your Zod schema allows, exposed or not. Your schema checks the shape of a write, like a number where a number belongs. It doesn't check who made the write. So a game can't stop an installed plugin from writing into `stat_data`.

That's on purpose. Installing a plugin is the player's decision, and installing it is what gives it the right to write. It's a mod for a PC game. A mod can change your save file, and that's exactly why you only install mods you trust.

What MVU Helper does guarantee: the plugin's engine runs in the same locked sandbox as yours, so it can't reach anything outside the chat and the MVU variables. And a write with the wrong shape is refused by your [schema](schema.md), same as one from your own game.

So exposing a path doesn't make it writable, and not exposing it doesn't protect it. It only tells plugins where to look.

How plugins are written is on [What is GameLogic Plugin](../gamelogic_plugin/README.md).

[Back to How a GameLogic Engine works](technical.md) · [Back to index](../../README.md)
