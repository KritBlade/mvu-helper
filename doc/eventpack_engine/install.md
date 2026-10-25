# Where an installed pack lives

> This page applies to any game. ArtificKoi shows up as a real example, not as a rule. See [Written for any game](technical.md#written-for-any-game).

Installing a pack puts it in 3 places. The card's lorebook gets the text. Every chat's save gets the rows. And a library outside the card keeps a copy, so a card rebuild can't lose it.

Each one has its own job, and this page goes through all 3.

## The Event Packs tab

You install from MVU Helper > Event Packs. It has 3 sections, in the same order as the GameLogic Packs tab:

- **On this card.** Every pack installed on the open card, with its version, its number of events and how many have fired. Its buttons are icons. **Disable**, the pause button, keeps the pack but takes its events out of play. **Uninstall**, the red bin, removes it from this card.
- **Pack library.** Every pack you ever imported. **Install to this card** puts one onto the open card. **Remove from library**, the red bin, only deletes the stored copy. It asks first.
- **Import.** Paste the pack text, or **Load file** (`.txt` or `.json`). Then **Validate**, then **Add & install**, which stores it in the library AND installs it on the open card in one go.

Each installed pack carries a pill that says its state:

| Pill | Means |
| --- | --- |
| **Installed** | installed and complete |
| **Disabled** | disabled |
| **Entry missing** | the lorebook entry is gone. Install it again from the library, or uninstall it |
| **No library copy** | installed, but there's no copy in the library. A card rebuild would lose it, so import it again to keep one |

When the card's engine doesn't say where its trigger table is, the row reads "fired state unknown" instead of a count, and a **Fired counts are unknown** notice above the rows says why.

Open a chat first. Installing writes into that card's lorebook and save.

## In the card's lorebook

Install writes 2 kinds of entry into the card's own lorebook.

**`[MVU_Event_Pack] <pack id>`**, one per pack, like `[MVU_Event_Pack] paulk.beach_arc`. It holds that pack's text, both halves. It's a constant entry, so it renders on every reply. That's fine, because it renders almost nothing:

- the JSON block sits inside `if (false)`, so it renders zero tokens,
- each scene body is gated on the armed pointer, so only the armed event's scene shows, and only on the reply it's armed.

So the narrator sees one scene when an event is armed, and nothing the rest of the time.

**`[MVU_Event_Pack_Registry]`**, one per card. A disabled entry, so it never reaches a prompt. It's the list of what's installed:

```json
{
  "paulk.beach_arc": { "ver": "1.0" }
}
```

The registry is a safety fence. MVU Helper only picks up packs the registry lists, and only the Event Packs tab writes to it. So pasting a pack's text into the lorebook by hand does nothing at all. A pack has to go through the install, and its checks.

It's like a guest list at the door. Being inside the building doesn't count. Your name has to be on the list.

## In the save: stat_data.EventPack

The engine runs in a sandbox, and it reads the save, not the lorebook. So the rows from the JSON block are copied into `stat_data`, under the root your game declares. ArtificKoi's is `EventPack`:

```json
"EventPack": {
  "triggers": {
    "paulk_beach_arc_invite": { "cat": "TRG", "series": "Beach Arc", "when": "...", "fx": { ... } },
    "paulk_beach_arc_day":    { "cat": "TRG", "series": "Beach Arc", "prereq": "...", "when": "...", "fx": { ... } }
  },
  "installed": {
    "paulk.beach_arc": { "ver": "1.0", "keys": ["paulk_beach_arc_invite", "paulk_beach_arc_day"] }
  },
  "fired": {
    "paulk_beach_arc_invite": { "state": "done", "scope": "arc", "at": "2026-04-11 10:20" }
  }
}
```

| Part | What it holds | Who writes it |
| --- | --- | --- |
| `triggers` | every event row the engine checks: the game's own events plus every installed pack's | the game's starting state, plus MVU Helper's install |
| `installed` | which rows belong to which pack, and its version | MVU Helper |
| `fired` | one done-marker per event that fired: `state`, `scope` and the game clock `at` | the engine, when an event fires |

**`triggers`** is the table `scanEvents` reads, every reply. The game's own events are in it too. ArtificKoi seeds its story events there from its starting state, and packs add theirs beside them. When the game itself updates, it can push its own changed rows into running chats, see [Your own events](host.md#your-own-events). That push replaces only the game's rows and deletes nothing, so a pack's rows stay put.

**`installed`** is how the engine knows which pack a row belongs to. When a row creates a record, the engine stamps that pack's id on it, see [Who owns a record](writes.md#who-owns-a-record). It's also the collision fence: a pack can never claim a key another pack, or the game, already owns.

**`fired`** is the done-marker, and it belongs to the library. Every event is a one-shot because of it. `flag:<key>` reads it, and the Event Packs tab counts it. It sits in the platform's own root on purpose. A world log is something a player tidies up, and a marker living there would un-fire itself.

**The armed pointer** lives outside this root, at the path your game declares. It holds the one event armed right now, as a `[value, label]` pair. ArtificKoi's is `EngineDerived.EventArmed`: `['@paulk_beach_arc_invite', 'Current Event']` while an event is armed, `['', 'Current Event']` when none is.

### How every chat gets the rows

The lorebook is shared by every chat of the card. The save belongs to one chat. So MVU Helper copies the rows into each chat:

- **on every chat load,** for every pack the registry lists,
- **before every generation,** onto the messages the next reply starts from. A regenerate or a delete restarts from an older message, from before the install, and without this the rows would be gone.

A pack already in a chat costs nothing. MVU Helper sees the rows match and moves on.

Installing never touches what has already happened in a chat. Only the event definitions move.

## In the library

The library is a lorebook that belongs to no character. Every pack you import is stored there, under its pack id.

Rebuilding or re-importing a card throws away its lorebook, and the packs with it. The library copy is what puts them back: **Install to this card**, and you're done.

## Upgrade, disable, uninstall

**Upgrade.** Install a higher `version` of the same pack id. Its rows replace the old ones, wholesale. Rows the new version dropped are removed. Same or older versions are refused. Uninstall first to roll back.

**Disable.** The pack stays installed, and its entry is switched off. Its rows leave every chat's `triggers`. **Enable**, the play button that takes its place, puts them back.

**Uninstall.** Deletes the pack's entry and its registry record. Its rows leave every chat. The library copy stays.

What NEVER moves, in all 3:

- the done-markers in `fired`. Reinstalling never re-fires a done event.
- anything a fired event wrote, like a quest or an item.

There's one exception. If the event the armed pointer names is gone, MVU Helper empties the pointer (the label stays). Otherwise the next reply would be told to play a scene that doesn't exist anymore.

## The checks at install

**Validate** runs every check, and **Add & install** only appears once the pack passes. One bad pack refuses the whole file.

- the identity: `creator`, `event`, `version` and `format` are there and legal,
- `format` matches what the pack actually uses,
- every key starts with the pack's prefix, and no key collides with one already installed,
- the size caps: 20 rows, 4 KB a row, 64 KB in all,
- one series per pack,
- every key has a gated body and an `eventFire` report,
- only the 3 allowed EJS shapes, gated on the armed path this game declares,
- every write names a path the game opens, on a path that can record who made a record,
- every reward is a kind the game pays, in the right shape,
- the armed pointer in the save is a `[value, label]` pair.

Some things are warnings, not refusals, and the pack still installs:

- a condition that matches no known shape, most likely a typo. It stays false at run time, see [When a token doesn't parse](dsl.md#when-a-token-doesnt-parse),
- a `scope` the game doesn't declare,
- an `fx` key the format doesn't know,
- more than one row in a series without a `flag:`.

Each refusal says what's wrong and how to fix it, like naming the armed path the game actually uses.

## Develop it with the dev loop

An event pack can be an artifact folder too, so the dev loop can install it every time you save:

```
paulk-beach-arc/
├── pack.json
└── events/
    └── paulk-beach-arc-event-pack.txt
```

```json
{
  "format": "1.0",
  "packType": "eventpack",
  "id": "paulk-beach-arc",
  "name": "Beach Arc",
  "description": "Event pack \"Beach Arc\" — v1.0.",
  "version": "1.0"
}
```

The builder's **Download artifact .zip** gives you exactly this. Extract it into your workspace, and the dev loop picks it up. See [Development Environment and Dev Loops](../dev_env/README.md).

- One folder is one pack. A long route is several folders, one per pack.
- The `id` is the pack id in lowercase with dashes: `paulk.beach_arc` becomes `paulk-beach-arc`.
- The dev loop reinstalls on every save, even when the version didn't move. A person installing by hand still has to bump it.
- Every file in `events/` is checked first. If one fails, none of them installs.

The template workspace ships one: `evenpack-test-series/`, a 3-step quest chain.

[Back to How the EventPack Engine works](technical.md) · [Back to index](../../README.md)
