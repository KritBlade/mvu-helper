# Writes and rewards

> This page applies to any game. ArtificKoi shows up as a real example, not as a rule. See [Written for any game](technical.md#written-for-any-game).

A write is how an event changes the save when it fires. The pack says WHAT it wants written. The game says WHERE a pack may write, and under which RULES. The library, `eventpack.cjs`, puts the 2 together.

It's like a shared kitchen. You can cook whatever you want, but only at the stations the owner opened, and only with your own pans.

## Who decides what

| Who | Decides | Where |
| --- | --- | --- |
| the pack | which writes it wants: path, record key, field values | the row's `fx.writes` |
| the game | which paths a pack may write, and the rules on each | `EVENT_PACK_ADAPTER.writes`, in the game's engine |
| the game's schema | which fields exist at that path, and their types | the game's Zod schema |
| the library | nothing about any game. It applies the rules it's given | `eventpack.cjs` |

There's no translation layer. A pack names the schema's own field, like `Step` or `Rel`, and the library writes exactly that field. A game that wants to open a new path adds one line to its own list. Nothing in the library or in MVU Helper changes.

## The shape of one write

```json
{ "path": "Mainchar.Quests", "key": "Beach_Day", "set": { "Step": 1, "Title": "Beach Day", "Status": "On-going" } }
```

| Field | What it does |
| --- | --- |
| `path` | one of the paths the game opens. Anything else is refused |
| `key` | the record inside that collection. Required on a collection, left out on a plain object. No `.` or `/` in it |
| `set` | field and value, written as they are, under the schema's own names |
| `add` | field and a number to add. Only on a field the game's rule lists |
| `remove` | `true` deletes the record. Only on a path the game marks removable |

A row can carry several writes, to one path or to many. They run in the order you wrote them. 2 writes to the same record in one row are fine, and land one after the other.

Every field is optional. A field you leave out stays as it is, so step 2 only carries what changed. The path creates itself if the save doesn't have it yet.

## Who owns a record

**A pack may create any record key nobody has claimed yet.** Call it `Ruinblade`, not `paulk_beach_arc_ruinblade`. No prefix needed.

**A pack may only overwrite or remove what it made itself.** When a pack creates a record, the engine writes the pack's id into it, in the field the game names as the path's `ownerStamp`. Later, a write from any other pack is refused:

```
WRITE REFUSED (Mainchar.Quests.Leila belongs to the story, not to any pack, not to paulk.beach_arc)
```

**A record with no stamp belongs to no pack.** The narrator or the player made it. No pack can touch it.

**The game's own events are never gated.** That's how an official event can take back an item the narrator handed out and never stamped.

**A path with no `ownerStamp` refuses every keyed pack write.** It fails closed. A game can't hand out an unguarded collection by forgetting a line.

### The one exception: a shared registry

Some records are a shared book of the world: the people you met, the places you found. A game marks a path like that `fillOnly`.

There, a pack names the key the world already uses, like `School_Cafeteria`, and can only fill in what's blank. The first value captured wins, for every field. A prefix here would only put a second cafeteria in the book the narrator reads.

```
WRITE WorldRecord.NPCs.StudentCouncilSecretary already registered — kept Name/Rel
```

Removing is never shared. Deleting a record is not filling a blank.

## The rules a game can put on a path

| Rule | What it does |
| --- | --- |
| `ownerStamp: 'Field'` | the field a record names its maker in. The owner gate above |
| `fixed: { Field: value }` | the engine writes it on every write. A pack can't set it |
| `stamp: 'Field'` | gets the game clock on every write. `DaysSince()` reads it |
| `locked: ['Field']` | a pack can neither set nor add it. Dropped, with a log line, and the rest of the write lands |
| `monotonic: ['Field']` | a value at or below the current one skips the WHOLE write. A negative `add` is refused |
| `fillOnly: true` or `['Field']` | a field that already has a value is never overwritten |
| `add: ['Field']` | the field takes a number to add, on top of `set` |
| `clamp: { Field: [min, max] }` | kept in range after the write. A bound is a number, or the name of a sibling field |
| `removable: true` | a write may carry `remove: true` |
| `removeAtZero: ['Field']` | the record is deleted when the field reaches 0 |
| `capacity: { max, evictBy }` | a new key past `max` first pushes out the oldest, by `evictBy` |

2 things hold on every path, whatever the game declares:

- a field whose name starts with `_` is never written by a pack. That's MVU's own read-only convention.
- a `key` can't contain `.` or `/`. Those are MVU's path separators.

## ArtificKoi's 4 paths

ArtificKoi opens 4 paths:

```js
writes: [
  { path: 'Mainchar.Quests', ownerStamp: 'GrantedBy', fixed: { Type: 'GameEvent' }, stamp: 'LastUpdated',
    monotonic: ['Step'], locked: ['Target', 'Difficulty', 'RewardStat', 'StepMax'] },
  { path: 'Mainchar.Inventory', ownerStamp: 'GrantedBy', removable: true },
  { path: 'WorldRecord.NPCs', ownerStamp: 'GrantedBy', stamp: 'FirstSeen', fillOnly: true },
  { path: 'WorldRecord.Locations', ownerStamp: 'GrantedBy', stamp: 'DiscoveredAt', fillOnly: true },
]
```

**`Mainchar.Quests`**, a quest chain:

| Field | You may set | Why |
| --- | --- | --- |
| `Step` | yes | monotonic. A replayed or stale fire can never roll a chain back |
| `Title`, `Status`, `Desc`, `Objective`, `ProgressSummary`, `Reward` | yes | free text. `Status` is `On-going` or `Completed` |
| `Type` | no, fixed | always `GameEvent`. The narrator's own quest updates skip a record that carries it |
| `LastUpdated` | no, stamp | the game clock. It goes away with the record |
| `Target`, `Difficulty`, `RewardStat`, `StepMax` | no, locked | the quest payout ladder. The engine works these out itself |

A `Completed` quest is deleted at that day's settle. That's why a chain gates on `flag:`, never on the quest.

**`Mainchar.Inventory`**, what the player carries: `Type`, `Desc` and `Qty`. It's ArtificKoi's only removable path, so a gift given away or an item used up can go. Only the pack that granted an item can take it back.

**`WorldRecord.NPCs`**, the people met: `Name` and `Rel`. Shared registry, blanks only. `FirstSeen` is stamped.

**`WorldRecord.Locations`**, the places found: `Label`, `Note`, `Privacy` and `Hours`. Shared registry, blanks only. `DiscoveredAt` is stamped. `Hours` is a category like `school` or `shops`, never a clock.

ArtificKoi lists no `add` field anywhere. Stats don't move through writes, see below.

## Rewards

A reward is what an event pays when it fires: money, a stat, affection. It's a separate field from `writes`, `fx.reward`, because its one rule is a ceiling.

```json
"reward": {
  "money":   { "Money": 5000 },
  "heroine": { "Mitsuki": { "Affection": 10 } }
}
```

The game declares the kinds it pays, in `EVENT_PACK_ADAPTER.rewards`. Each kind has a list of fields it may pay, a range the result stays in, and a ceiling for one event.

- **Over the ceiling is paid at the ceiling,** and the log says so. A beat that reads as generous never lands as nothing.
- **A negative amount is a penalty,** held to the same ceiling.
- **A keyed kind** pays one member of a collection, and the row names who: `"Mitsuki"`. It never creates a member.
- **A selector** names whoever a true/false field marks, when no author could know the name: `"Classmate.*.Is_present"` pays the one girl in the scene. Nobody, or more than one, and it pays no one and says so. That's format `1.2`.
- **A text kind** writes words over the field instead of adding a number. It's cut at the kind's length limit.

A kind the game doesn't pay is refused at install, naming what the game does pay. So is a kind asked for in the wrong shape.

ArtificKoi pays 4 kinds:

| Kind | Pays | Ceiling per event |
| --- | --- | --- |
| `stat` | `Mainchar`'s `Int`, `Str`, `Cha`, `Sta` | 10 |
| `money` | `Mainchar`'s `Money`, `Salary` | 50,000 Money, 10,000 Salary |
| `heroine` | one classmate's stats and experience, `Lewdness` and `Affection` | 20 for `Lewdness` and `Affection`, 8 for the rest |
| `appearance` | one classmate's `Cup_Size`, `Height`, `Body_Measurements`, `Hair_Style`, `Physical_Features`, as text | 400 characters |

## Stats move through the story

Writes are for structure: a quest, an item, a record. They're not how a pack moves the numbers your game already looks after.

Mood, and most affection, move through the story. The scene plays a moment, the narrator reports what happened, and your game applies it with all its usual limits. An event that should pay something on top says so in `fx.reward`, held to the game's ceiling.

## A path the game doesn't open

```json
"writes": [ { "path": "Mainchar", "set": { "Age": 19 } } ]
```

Nothing is written. `Mainchar` isn't one of ArtificKoi's 4 paths, so the write is refused 3 times, loudly:

1. **At install,** the pack is refused: `this card's engine allows no writes into Mainchar — it allows: Mainchar.Quests, Mainchar.Inventory, WorldRecord.NPCs, WorldRecord.Locations`.
2. **On every chat load,** in case the engine changed after install: a warning naming the same paths.
3. **When the event fires:** `WRITE REFUSED (path not declared): Mainchar`.

The event itself still fires. The scene plays, the done-marker goes in, and only the write is dropped.

## Everything an event can reach

On ArtificKoi, every event can reach exactly 6 places:

| Written by | Where |
| --- | --- |
| a write | `Mainchar.Quests`, a key nobody claimed, or one the pack made |
| a write | `Mainchar.Inventory`, same, and the only removable one |
| a write | `WorldRecord.NPCs`, any key, blanks only |
| a write | `WorldRecord.Locations`, any key, blanks only |
| the done-marker, always | `EventPack.fired.<key>` |
| clearing the armed pointer, always | `EngineDerived.EventArmed` |

Plus whatever its `reward` pays, inside the game's ceilings. A write is data the library applies. A pack can't express a code path.

[Back to How the EventPack Engine works](technical.md) · [Back to index](../../README.md)
