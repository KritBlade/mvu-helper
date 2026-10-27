# Host event packs in your game

> This page applies to any game. ArtificKoi shows up as a real example, not as a rule. See [Written for any game](technical.md#written-for-any-game).

Your game hosts event packs by loading one shared library, `eventpack.cjs`, and declaring an adapter: where your event state lives, where a pack may write, and what it may pay. You do it once. Nothing per pack is ever written into your engine.

It's like a games console. You build the slot once, and every cartridge after that just plugs in.

## eventpack.cjs is not yours to edit

`eventpack.cjs` is owned by the MVU Helper author. It's a distributed file: MVU Helper releases it, and every game ships the exact same copy.

So never change your copy. Every pack is written against that one library, and so are MVU Helper's install checks and the builder. A copy you changed is a game where packs written for everyone else quietly stop working.

Need a feature it doesn't have? Raise a PR on [MVU Helper's repository](https://github.com/KritBlade/mvu-helper). Once it's merged, it ships in the next release, for every game at once.

## 3 steps

The blank GameLogic Pack's `engine/README.txt` walks you through all 3, with a whole working `gameLogic.cjs`. In short:

**1. Get the file.** Save `eventpack.cjs` as `engine/eventpack.cjs`, and never edit it, see above. To update it, replace the whole file with the new release. Download it from MVU Helper's [`eventpack_lib/`](https://github.com/KritBlade/mvu-helper/tree/main/eventpack_lib) folder.

**2. Load it before your engine,** in `pack.json`:

```json
"engineOrder": ["eventpack.cjs", "gameLogic.cjs"]
```

The files in `engineOrder` run as one script, in order. `eventpack.cjs` leaves its functions on `globalThis.__EVENTPACK__`, and your engine picks them up.

**3. Wire it into `resolveTurn`, and export the adapter:**

```js
const EVENTS = globalThis.__EVENTPACK__ || null;

function resolveTurn(statData, ctx) {
    const log = [];
    let applied = false;
    // The narrator played the armed event: "<key>" or "<key>:<Outcome>".
    const intent = statData.Intent || {};
    const fired = String(get(intent.eventFire, '')).trim();
    let didFire = false;
    if (fired) {
        didFire = EVENTS.applyEventFire(statData, fired, log, EVENT_PACK_ADAPTER);
        setValue(intent, 'eventFire', '');   // consumed, fired or refused: never applied twice
        applied = true;
    }
    // Arm the next event for the next reply. Not in the reply one fired, so a series' next step waits.
    if (!didFire && EVENTS.scanEvents(statData, log, EVENT_PACK_ADAPTER)) applied = true;
    return { statData, applied, log };
}

module.exports = {
    ENGINE_VERSION, ENGINE_NAME, ENGINE_TYPE,
    EVENT_PACK_ADAPTER,
    EVENT_PACK_FORMAT: (EVENTS && EVENTS.FORMAT) || null,
    resolveTurn,
};
```

`/Intent/eventFire` belongs to the format, not to your game. Every pack's FIRE line reports on that channel, and MVU Helper refuses a pack without it. So your engine reads exactly that channel.

## The adapter

```js
const EVENT_PACK_ADAPTER = {
    triggerRoot: 'EventPack.triggers',
    armedPath: 'EventPack.armed',
    writes: [],
    scopes: [],
    get,
    getArmed: (sd) => String(get(sd.EventPack && sd.EventPack.armed, '')),
    setArmed: (sd, v) => setValue(sd.EventPack || (sd.EventPack = {}), 'armed', v),
    warn: (message) => { warnings.push('eventpack: ' + message); },
};
```

That's the blank pack's. Every field is a declaration:

| Field | Required | What it declares |
| --- | --- | --- |
| `triggerRoot` | yes | where the trigger table lives, like `EventPack.triggers`. The library keeps `installed` and `fired` right beside it |
| `armedPath` | yes | where the armed pointer lives. Every scene body is gated on it |
| `get(value, default)` | yes | how to read one of your values. ArtificKoi unwraps `[value, label]` pairs |
| `getArmed(sd)`, `setArmed(sd, v)` | yes | read and write the armed pointer: `'@<key>'`, or `''` for none. Always a string, and keep the label |
| `warn(message)` | yes | where the library's warnings go. It never prints on its own |
| `writes` | for writes | where a pack may write, and the rules on each path, see [Writes and rewards](writes.md) |
| `rewards` | no | what an event may pay, and the ceilings, see [Rewards](writes.md#rewards). Leave it out, and your game pays nothing |
| `scopes` | no | the `scope` values your game knows. Leave it out, and the builder's Scope box is free text |
| `bodyEntry` | no | where an installed pack's scenes go in your prompt, see [Where a pack's scene goes](#where-a-packs-scene-goes). Leave it out, and they get SillyTavern's default slot |
| `aliases` | no | your condition shortcuts, like `{ 'Aff(*)': 'Classmate.*.Affection' }`. A `*` captures a part and lands in the path |
| `presence` | for `Present()` | the field `Present(Name)` tests for `true`, like `'Classmate.*.Is_present'` |
| `resolveScalar(sd, name)`, `sugar` | no | a condition name that genuinely computes, like a party size. Return the name unchanged for anything you don't claim |
| `nowStamp(sd)` | for stamps | your game clock. The string every `stamp` field gets, and the done-marker's `at` |
| `daysSince(sd, stamp)` | for `DaysSince()` | whole days from a stamp to the day being played, or `null` for a non-stamp |

A missing optional hook degrades with a named warning, never a crash. A missing `daysSince` makes every `DaysSince()` read as never, warned once.

**Only your game knows which day is being played.** That's why `daysSince` is yours. A plain calendar clock is one line:

```js
daysSince: (sd, s) => EVENTS.civilDaysSince(nowStamp(sd), s),
```

**`EVENT_PACK_FORMAT`** is the format your engine runs. Pass the library's own `FORMAT` straight through, never a number you type. A second copy is a copy that can disagree.

## Where a pack's scene goes

Every installed pack is one lorebook entry, and `bodyEntry` says where that entry sits in your prompt. It uses the same words a lorebook entry does:

```js
bodyEntry: { position: 'at_depth_as_system', depth: 0, order: 750 },
```

| Field | What it is |
| --- | --- |
| `position` | the lorebook position: `before_character_definition`, `after_character_definition`, `before_example_messages`, `after_example_messages`, `before_author_note`, `after_author_note`, `at_depth_as_system`, `at_depth_as_assistant` or `at_depth_as_user` |
| `depth` | for an `at_depth_*` position only: how many messages from the end. `0` is right after the player's line |
| `order` | the lorebook order. Lower goes first, and it's dropped first when the lorebook runs out of budget |

MVU Helper writes these 3 fields onto every pack entry it installs. It never decides them for you, because where a scene works best is your prompt's design, not MVU Helper's.

**Put it where the narrator plans from.** A model plans its reply from the end of the prompt. A scene sitting in the middle can be followed word for word, and still never make it into the plan. ArtificKoi puts pack scenes at depth 0, right after the player's line, with order 750. That's below its own story scenes (994), so a pack scene is the first to go when the budget is tight.

**It's also cheaper.** The scene only shows on the reply its event is armed. Sitting at the end, it changes only the end of the prompt, so everything before it stays cached.

A `bodyEntry` that's malformed refuses the install, naming the field. Leave it out, and pack entries get SillyTavern's default slot, before the character definition.

## The armed pointer is a [value, label] pair

Every scene body is gated like this:

```
<%_ if (getvar('stat_data.EventPack.armed[0]') === '@<key>') { _%>
```

The `[0]` reads the value of a `[value, label]` pair. On a plain string, `[0]` reads only `'@'`, and no gate would ever open.

So the armed pointer has exactly one shape: `['@<key>', 'label']` while an event is armed, `['', 'label']` when none is. Seed it in your starting state. ArtificKoi's is `"EventArmed": ["", "Current Event"]`, under `EngineDerived`.

MVU Helper refuses an install onto any other shape, and logs an error on every chat load while packs are installed on one.

## Who reads your adapter

Both tools read the EXPORTED adapter. Export it, and that's the whole job.

- **MVU Helper** asks the engine it already loaded: at install, every reply, and before each generation. Change the adapter, reload the engine, and MVU Helper reads the new one.
- **MVU Status Menu Builder** gets a card file, with no chat and nothing running. So it runs your engine itself, found by its `[MVU_LogicEngine]` entry, and reads the same exports.

An adapter you build but never export reads as a game that can't host packs at all. A declaration that's missing is a refusal naming the field, never a guess.

## Your own events

Your game's own story events run on the same engine. Put their rows in your trigger table from your starting state, and their scene bodies in your own lorebook entries, gated the same way.

Your own rows are never owner-gated. That's how an official event can take back an item the narrator handed out and never stamped.

ArtificKoi seeds its story events into `EventPack.triggers` from its starting state, and installed packs land beside them.

A row you add reaches running chats on their next load. A row you change doesn't, until you push it: list your trigger table in `pack.json`'s `state.forceFromInitVar` and bump `state.version`. MVU Helper then replaces the rows your starting state carries, once per save, and deletes none, so every installed pack's rows stay. See [State corrections](../gamelogic_engine/state.md#forcefrominitvar-pushes-what-you-changed). ArtificKoi pushes `EventPack.triggers` this way.

## Do

- **Load `eventpack.cjs` unchanged,** and declare only the adapter.
- **Report fires on `/Intent/eventFire`,** hand them to `applyEventFire`, and clear the channel so it never applies twice.
- **Keep your schema's root open,** or declare `EventPack` yourself. A closed root strips it on the next save. See [Keep the root open](../gamelogic_engine/schema.md#keep-the-root-open).
- **Offer same reply play, if you want it.** Export `pickSameRoundEvent`, and show your PRE calls the library's `sweepCandidateLines` and `readyEvent`. See [pickSameRoundEvent](../gamelogic_engine/hooks.md#picksameroundevent) and [Pattern 2](../gamelogic_engine/same_reply.md#pattern-2-an-event-that-fires-the-moment-its-ready).

## Don't

- **Don't write an applier.** There's no `fx.<type>` to map. A pack names a path you opened and your schema's own fields, and the library writes them under your rules.
- **Don't re-implement the grammar,** the left-side lookup, or the tie-break. That drift is what the library exists to kill. Need a new kind of condition? That's a PR, because it changes all 3 copies at once, see [Why the grammar lives in 3 places](technical.md#why-the-grammar-lives-in-3-places).
- **Don't weaken the owner gate.** A path with no `ownerStamp` refuses every keyed pack write, on purpose.
- **Don't let packs change state by any other route.** Install, upgrade and uninstall only move event definitions.
- **Don't write prose into a world log from the engine.** If a beat belongs in your log, the scene asks the narrator to report it.

[Back to How the EventPack Engine works](technical.md) · [Back to index](../../README.md)
