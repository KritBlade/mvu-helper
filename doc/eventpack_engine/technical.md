# How the EventPack Engine works

An event pack is data. The code that runs it is one shared library, `eventpack.cjs`, loaded inside your game's engine. Your game declares where things live, once, and every pack after that is just data.

This page follows one event from the pack text to the save. The pages with the details come first.

## The technical pages

Read them in this order, or jump to the one you need:

1. [The event pack file](file.md) > the 2 halves, the identity, the trigger rows and the scene bodies.
2. [Writes and rewards](writes.md) > what an event changes when it fires, and the rules your game puts on it.
3. [Where an installed pack lives](install.md) > the lorebook entries, `stat_data.EventPack`, and the Event Packs tab.
4. [Build events in MVU Status Menu Builder](builder.md) > the Event Pack tab, section by section.
5. [The condition language](dsl.md) > every condition, how it's checked, and how to hand write one.
6. [Host event packs in your game](host.md) > what your engine declares, so packs can run on it.

## Written for any game

An event pack is general by nature. It's written for one game, but the engine that runs it is the same for every game. ArtificKoi shows up on these pages as a real host, because it's the first game that hosts event packs.

What every game shares is only what `eventpack.cjs` and MVU Helper provide: the pack format, the condition language, the `/Intent/eventFire` channel, and the done-marker. Everything else comes from what your game declares: where a pack may write, the shortcuts in conditions like `Aff(Mitsuki)`, and what an event may pay. Each page says which is which.

## The parts

| Part | What it is | Where it lives |
| --- | --- | --- |
| the pack text | a hidden `<mvueventpack>` JSON block, plus one scene body per event | one `.txt` file, or `events/` in an artifact folder |
| `[MVU_Event_Pack] <pack id>` | the pack text, installed | the card's lorebook, one entry per pack |
| `[MVU_Event_Pack_Registry]` | which packs are installed, and their versions | the card's lorebook |
| `EventPack.triggers` | every event row the engine checks | `stat_data`, in every chat |
| `EventPack.installed` | which rows belong to which pack | `stat_data` |
| `EventPack.fired` | the done-marker of every event that fired | `stat_data` |
| the armed pointer | the one event armed right now | `stat_data`, at the path your game declares |
| `eventpack.cjs` | the library: conditions, arming, verify-at-fire, writes, rewards | your engine's `engine/` folder |
| `EVENT_PACK_ADAPTER` | your game's declarations: paths, write rules, rewards, shortcuts | your engine, exported |

`EventPack` is the root your game picks with its `triggerRoot`. `installed` and `fired` always sit right beside `triggers`. What each one holds is on [Where an installed pack lives](install.md).

## One event, start to finish

Take a pack by `paulK` called `Beach Arc`. Its first event, `paulk_beach_arc_invite`, needs a Saturday, 10:00 or later, and Mitsuki's affection at 40 or more. When it fires, it opens a quest.

### 1. Install puts it in 2 places

The player installs the pack in the Event Packs tab. The whole text goes into the card's lorebook as `[MVU_Event_Pack] paulk.beach_arc`. The rows from the JSON block go into `stat_data.EventPack.triggers`, in every chat of that card.

### 2. RES1 checks every row, every reply

Your `resolveTurn` calls the library's `scanEvents`. It checks every row in `EventPack.triggers`:

- not fired yet,
- its `prereq` holds,
- its `when` holds.

The winner gets armed. ArtificKoi's armed pointer, `EngineDerived.EventArmed`, becomes `['@paulk_beach_arc_invite', 'Current Event']`.

If 2 events are ready at once, only one wins. A `TIME` row beats a `TRG` row, then the row with more conditions wins, then the one listed first.

### 3. The scene reaches the narrator

On the next reply, the pack's lorebook entry is in the prompt, because one of its events is armed. On every other reply its `@@if` drops it. It sits where the game's `bodyEntry` says, see [Where a pack's scene goes](host.md#where-a-packs-scene-goes). ST-Prompt-Template renders it. The JSON block sits inside `if (false)`, so it renders nothing. Each scene body sits behind a gate on the armed pointer, and only the armed one opens:

```
<%_ if (getvar('stat_data.EngineDerived.EventArmed[0]') === '@paulk_beach_arc_invite') { _%>
```

So the narrator sees exactly one scene, and the rest of the pack costs zero tokens.

### 4. The narrator plays it and reports it

The scene's FIRE line asks the narrator to report `/Intent/eventFire "paulk_beach_arc_invite"`. That report is the only way an event fires. A scene that plays and never reports it changes nothing, and plays again.

### 5. RES1 checks it again, then commits it

Your `resolveTurn` hands the report to the library's `applyEventFire`. It checks the row one more time, on the state now or on the state the reply began on. If neither backs it, the log says `EVENT FIRE REJECTED` and nothing changes.

If it holds, in this order:

1. the row's writes land: the quest opens in `Mainchar.Quests`,
2. the row's reward is paid, if it has one,
3. the done-marker goes in: `EventPack.fired.paulk_beach_arc_invite = { state: "done", scope: "arc", at: "<the game clock>" }`,
4. the armed pointer is cleared,
5. the log says `EVENT FIRED: paulk_beach_arc_invite`.

Then your engine skips the scan for that reply. ArtificKoi does, and so does the blank pack's example. That's what makes the next step of a chain wait at least one reply.

### Arm now, play next reply

That's the default: an event arms in one reply and plays in the next. With same reply protection, it can play in the reply its last condition comes true. See [Pattern 2: an event that fires the moment it's ready](../gamelogic_engine/same_reply.md#pattern-2-an-event-that-fires-the-moment-its-ready).

## Why the grammar lives in 3 places

The condition language is read by 3 programs, at 3 different times:

| | Copy | Who runs it | What it does with a condition |
| --- | --- | --- | --- |
| 1 | `eventpack.cjs` | your game's engine | checks it against the state, every reply. This is the source of truth |
| 2 | `src/features/event-pack/when-dsl-grammar.js` | MVU Helper | checks its shape when you install |
| 3 | `landing-app/src/utils/when-dsl-grammar.js` | MVU Status Menu Builder | reads it into the GUI, and writes it back out |

None of the 3 can call the others at run time. They ship separately. So the grammar is copied, and every copy carries the same grammar version, now v1.7.0.

Copies 2 and 3 are the exact same file, byte for byte. MVU Helper's tests run the real `eventpack.cjs` against copy 2 over a list of conditions, so a grammar change that skips a copy fails a test by name.

That's the reason a new kind of condition is rare. It needs all 3 copies changed in one pass, and every game already out there refuses packs that use it until it ships a new engine.

Basically, the pack is data, `eventpack.cjs` runs it, and your game only declares where things live.

[Back to What is EventPack Engine](README.md) · [Back to index](../../README.md)
