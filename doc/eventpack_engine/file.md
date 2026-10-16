# The event pack file

> This page applies to any game. ArtificKoi shows up as a real example, not as a rule. See [Written for any game](technical.md#written-for-any-game).

An event pack is one block of text with 2 halves. The first half is the rules, hidden from the AI. The second half is the scenes, one per event, that the narrator plays.

You normally get this text from the builder, see [Build events in MVU Status Menu Builder](builder.md). This page is what's inside it, for when you want to read it, fix it or write it by hand.

## The whole shape

```
<%_ if (false) { _%>
<mvueventpack>
{
  "format": "1.0",
  "creator": "paulK",
  "event": "Beach Arc",
  "version": "1.0",
  "builtWith": "MvuStatMenuBuilder 2.5.2",
  "triggers": {
    "paulk_beach_arc_invite": { ... one trigger row ... },
    "paulk_beach_arc_day":    { ... one trigger row ... }
  }
}
</mvueventpack>
<%_ } _%>
<%_ if (getvar('stat_data.EngineDerived.EventArmed[0]') === '@paulk_beach_arc_invite') { _%>
<Event_Pack>
@paulk_beach_arc_invite  Beach Invite ·1
  DO  ...what the narrator plays...
  FIRE  emit /Intent/eventFire "paulk_beach_arc_invite" -> ...what the fire does...
</Event_Pack>
<%_ } _%>
... one more gated body per event ...
```

**The rules half** is the JSON inside `<mvueventpack>`. It sits inside `if (false)`, so it renders zero tokens. The AI never reads it. The engine reads it after install, from the save.

**The scenes half** is one body per event, each behind a gate. A body only renders on the reply its event is armed. So the narrator sees one scene at a time, never the whole pack.

## The identity

| Field | Required | What it does |
| --- | --- | --- |
| `format` | yes | the pack format this pack needs, see [format and version](#format-and-version) |
| `creator` | yes | your name. It may not contain the word `official`, which belongs to the game's own events |
| `event` | yes | the pack's name |
| `version` | yes | your own revision, `1.0` or `1.2.1`. Bump it on every change |
| `builtWith` | no | which tool made the file. A receipt, never checked |
| `triggers` | yes | the trigger rows, one per event, by key |

The pack id and the key prefix come from `creator` and `event`. Both are slugged: lowercase, spaces become `_`, and only `a-z`, `0-9` and `_` survive.

| From | You get |
| --- | --- |
| `creator: "paulK"`, `event: "Beach Arc"` | pack id `paulk.beach_arc` |
| | key prefix `paulk_beach_arc_` |

**Every trigger key starts with the prefix.** `paulk_beach_arc_invite` is fine. `beach_invite` is refused. A name with no latin letters at all, like a creator written only in Chinese, slugs to nothing and is refused, so put at least one latin word in each.

## One pack, one series

A pack is one story arc, up to 20 events. A second arc is a second pack.

The caps:

- 20 trigger rows per pack,
- 4 KB of JSON per row,
- 64 KB for the whole text.

One file can still carry several packs, one `<mvueventpack>` block each with its own bodies. A long route is written that way: `Mitsuki Route 1`, `Mitsuki Route 2`, chained together. They install all together or not at all, so pack 2 never lands without pack 1.

## A trigger row

```json
"paulk_beach_arc_invite": {
  "cat": "TRG",
  "series": "Beach Arc",
  "when": "Wkd=Saturday & T>=10:00 & Aff(Mitsuki)>=40",
  "fx": {
    "summary": "Mitsuki invites you to the beach.",
    "scope": "arc",
    "writes": [
      { "path": "Mainchar.Quests", "key": "Beach_Day",
        "set": { "Step": 1, "Title": "Beach Day", "Status": "On-going", "Objective": "Go to the beach with Mitsuki." } }
    ]
  }
}
```

| Field | What it does |
| --- | --- |
| `cat` | `TRG` for nearly everything. `TIME` for a beat tied to the clock or the calendar. When 2 events are ready at once, `TIME` wins |
| `series` | the arc's name, the same on every row of the pack |
| `prereq` | is this event on the table at all. AND only. Leave it out, or `""`, for none |
| `when` | is this the moment. Conditions joined with `&` |
| `whenAny` | instead of `when`, for OR: a list of alternatives, any one is enough. A row can't have both |
| `fx` | what the event commits when it fires |

The conditions in `prereq`, `when` and `whenAny` are written in the condition language, see [The condition language](dsl.md).

### fx: what the event commits

| Field | What it does |
| --- | --- |
| `summary` | one line naming what the row does. A label for you and for the pack list. Nothing writes it into the save |
| `scope` | whether the event can fire again after the story loops, see [scope](#scope-save-or-arc) |
| `writes` | the records the event creates or changes, see [Writes and rewards](writes.md) |
| `reward` | what the event pays, like money or a stat, see [Writes and rewards](writes.md#rewards) |

That's the whole list. Any other key under `fx` is reported at install and ignored at fire, and the event still fires.

**An event with no `writes` and no `reward` is fine.** It plays, it's marked done, and no state moves. Use it for a beat that should just happen once.

## prereq vs when

Both must hold before an event can fire. The split is the most important choice you make in a row.

- **`prereq`** is durable story state. Has an earlier event fired? Has a quest reached a step?
- **`when`** is the moment. The time, the place, who's in the scene, a mood.

Here's why it matters. For every event whose `prereq` holds and whose `when` is exactly one condition short, the engine can tell the PRE call which condition is missing:

```
paulk_beach_arc_day · need Loc=Beach
```

So the story can steer toward it, and with same reply protection the event can fire in the reply the player walks onto the beach. Put the moment in `prereq` instead, and the engine can't see it's one step away.

It's like a theme park ride. The `prereq` is your ticket: you either bought one or you didn't. The `when` is the line: the ride runs when you get to the front.

## Chaining a series

Every step after the first gates on the step before it having fired. That's the `flag:` condition:

- **Step 1:** no `prereq`. `when` is the moment.
- **Step 2:** `prereq` is `flag:paulk_beach_arc_invite`. `when` is its own moment.

Step 1 needs no gate of its own. Its done-marker is what keeps it from firing twice. Only step 1 may go without a `flag:`. If 2 rows of one series have none, MVU Helper warns at install.

**Never chain on a record a step wrote,** like a quest's `Step`. A game may delete a record later. ArtificKoi deletes a quest the day it's `Completed`, and every step that read it can then never fire. The done-marker is the engine's own, and nothing deletes it.

## scope: save or arc

`scope` is stored on the event's done-marker when it fires. It answers one question: does this event stay fired after the story loops?

The values come from the game. The library stores your word as it is, and the game decides what it means. So use exactly the values the game declares. The builder only offers those.

ArtificKoi declares 2, `save` and `arc`. Its loop is the Graduation time leap:

| You write | At the time leap |
| --- | --- |
| `"save"` | the marker stays. The event is once ever |
| `"arc"` | the marker is cleared. The event can fire again next loop |
| nothing | same as `arc`. That's the default |
| `"Save"`, `"once"`, any typo | same as `arc`, silently. MVU Helper warns at install, naming the row |

An event that never fired has no marker, so a loop never touches it. It simply arms again when its conditions hold.

## The scene bodies

Every trigger key needs one body, gated on exactly that key:

```
<%_ if (getvar('stat_data.EngineDerived.EventArmed[0]') === '@paulk_beach_arc_invite') { _%>
<Event_Pack>
@paulk_beach_arc_invite  Beach Invite ·1
  DO  Mitsuki catches {{user}} after class, phone out, weather app open. She wants one full beach day,
      just the 2 of them. Play her pitch, and let {{user}} answer. Do not skip time, do not add characters.
  FIRE  emit /Intent/eventFire "paulk_beach_arc_invite" -> the engine opens the Beach Day quest at Step 1.
</Event_Pack>
<%_ } _%>
```

- **The gate** compares the armed pointer with `'@'` plus the key. The key inside the JSON has no `@`.
- **`EngineDerived.EventArmed` is ArtificKoi's armed path,** not a constant. Each game declares its own. Get it wrong, and MVU Helper refuses the install and names the right one.
- **The `[0]` is required.** The armed pointer is a `[value, label]` pair, and `[0]` reads the value. Without it, the gate never opens, and MVU Helper refuses it.
- **`DO`** is what the narrator plays. A short, concrete slice: who does what, in a sentence or 2. Say what must NOT happen, too.
- **`FIRE`** asks the narrator to report `/Intent/eventFire "<key>"`. That report is what makes the engine commit the event. The text after `->` is only a note for the narrator.

The header line, `@key  Title ·1`, is for reading only.

**Only 3 EJS shapes are allowed anywhere in the text:** the `if (false)` wrapper, the flat gate above, and the `<%_ } _%>` that closes them. Anything else is refused at install. So a pack can't hide code.

**A scene can branch.** Report `"<key>:<Outcome>"`, like `"paulk_beach_arc_day:Great"`, and the outcome shows in the log: `EVENT FIRED: paulk_beach_arc_day (Great)`.

**A beat worth remembering says so in its FIRE line.** The engine writes no prose anywhere. If the beat belongs in your game's world log, ask the narrator to report it the way your game records memories. ArtificKoi's is `/Intent/recordEvent`:

```
  FIRE  emit /Intent/eventFire "paulk_beach_arc_day"
        emit /Intent/recordEvent "save|Spent a whole day at the beach with Mitsuki."
```

## format and version

They're 2 different things:

- **`format`** is the pack format this pack needs. It goes up when you use a newer feature.
- **`version`** is your own revision. It goes up every time you change the pack.

| `format` | What needs it |
| --- | --- |
| `1.0` | every condition, `whenAny`, and `writes` |
| `1.1` | a row with a `reward` |
| `1.2` | a reward that names its member by a selector, like `Classmate.*.Is_present` |

MVU Helper checks `format` against what you actually wrote. A pack that uses a reward but says `1.0` is refused, with the number to use. The builder works the number out for you.

The game's engine declares a format too. A pack that needs a newer major format than the game's never gets its events into the save, and MVU Helper tells you to update the card.

**Keys never change between versions.** The pack id and `version` drive upgrades. The keys stay the same, so a fired event stays fired and a chain keeps its place. Same or older versions are refused. To roll back, uninstall first.

## A whole pack: 2 steps

```
<%_ if (false) { _%>
<mvueventpack>
{
  "format": "1.0",
  "creator": "paulK",
  "event": "Beach Arc",
  "version": "1.0",
  "triggers": {
    "paulk_beach_arc_invite": {
      "cat": "TRG",
      "series": "Beach Arc",
      "when": "Wkd=Saturday & T>=10:00 & Aff(Mitsuki)>=40",
      "fx": {
        "summary": "Mitsuki invites you to the beach.",
        "scope": "arc",
        "writes": [
          { "path": "Mainchar.Quests", "key": "Beach_Day",
            "set": { "Step": 1, "Title": "Beach Day", "Status": "On-going",
                     "Desc": "Mitsuki wants a whole beach day.", "Objective": "Go to the beach with Mitsuki." } }
        ]
      }
    },
    "paulk_beach_arc_day": {
      "cat": "TRG",
      "series": "Beach Arc",
      "prereq": "flag:paulk_beach_arc_invite",
      "when": "Loc=Beach & Present(Mitsuki)",
      "fx": {
        "summary": "The beach day with Mitsuki.",
        "scope": "arc",
        "writes": [
          { "path": "Mainchar.Quests", "key": "Beach_Day",
            "set": { "Step": 2, "Status": "Completed", "Reward": "A summer memory." } }
        ]
      }
    }
  }
}
</mvueventpack>
<%_ } _%>
<%_ if (getvar('stat_data.EngineDerived.EventArmed[0]') === '@paulk_beach_arc_invite') { _%>
<Event_Pack>
@paulk_beach_arc_invite  Beach Invite ·1
  DO  Mitsuki catches {{user}} after class, phone out, weather app open. She wants one full beach day,
      just the 2 of them. Play her pitch, and let {{user}} answer. Do not skip time, do not add characters.
  FIRE  emit /Intent/eventFire "paulk_beach_arc_invite" -> the engine opens the Beach Day quest at Step 1.
</Event_Pack>
<%_ } _%>
<%_ if (getvar('stat_data.EngineDerived.EventArmed[0]') === '@paulk_beach_arc_day') { _%>
<Event_Pack>
@paulk_beach_arc_day  Beach Day ·2
  DO  The beach day itself. Play it to fit how the 2 of them get along so far, and end on how close
      they actually got.
  FIRE  emit /Intent/eventFire "paulk_beach_arc_day" -> the engine completes the Beach Day quest.
</Event_Pack>
<%_ } _%>
```

The quest key, `Beach_Day`, has no prefix. A write may use any record key nobody has claimed yet, see [Writes and rewards](writes.md#who-owns-a-record).

## Before you share it

- `creator`, `event` and `version` are filled, and every key starts with your prefix.
- One `series` on every row, and 20 rows at most.
- Every key has a gated body and an `eventFire` report.
- Only the 3 allowed EJS shapes, anywhere in the text.
- Every condition uses a path or a shortcut the game declares.
- Every write names a path the game opens, and the game's own field names.
- MVU Helper's Event Packs tab > Validate says "Pack is valid", with no warning you can't explain.

[Back to How the EventPack Engine works](technical.md) · [Back to index](../../README.md)
