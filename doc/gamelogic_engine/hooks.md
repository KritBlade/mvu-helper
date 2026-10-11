# The hooks in detail

> This page applies to any game. ArtificKoi shows up as a real example, not as a rule. See [A general design, with one real example](technical.md#a-general-design-with-one-real-example).

MVU Helper calls your engine by name, at fixed points of every reply. `resolveTurn` is the only one you must have. Every other hook adds one thing your game can do, and if you don't export it, your game simply doesn't do that thing.

The basics of `resolveTurn` and `resolvePostRelay` are on [How a GameLogic Engine works](technical.md#the-2-entry-points). This page is everything else.

## The declarations

Your engine starts with 3 names and ends with a `module.exports`:

```js
const ENGINE_VERSION = 'v0.1.0';   // required, a string on its own line
const ENGINE_NAME = 'my-game';     // which game
const ENGINE_TYPE = 'RPG';     // which family of games RPG, Love, School..etc.

function resolveTurn(statData, ctx) {
    return { statData, applied: false, log: [] };
}

module.exports = { ENGINE_VERSION, ENGINE_NAME, ENGINE_TYPE, resolveTurn };
```

- **`ENGINE_VERSION`** is required. MVU Helper reads it from the running engine, and also from the source when it checks a pack that isn't loaded yet. That's why it has to be a plain string on a line of its own, and exported. It shows on the load line and in `{{mvuhelperEngineVersion}}`. It's never compared. The pack's `version` is what an install compares.
- **`ENGINE_NAME`** names your game. The load line, `MvuHelper.engineInfo().name`, `{{mvuhelperEngineName}}` and every plugin that asks "which game am I on?" read it.
- **`ENGINE_TYPE`** names the family. `MvuHelper.engineInfo().type` reports it.
- **`EVENT_PACK_ADAPTER`** and **`EVENT_PACK_FORMAT`** let your game host event packs. See [Where the engine runs](runtime.md#hosting-event-packs).

## The 4 hooks

| Hook | Called | Receives | Returns |
| --- | --- | --- | --- |
| `preAssemblyPatch` | before the PRE calls and the narrator | the base floor's state, `{ type, mid, swipe, generationAttempt }` | JSON Patch ops, or `[]` |
| `pickSameRoundEvent` | after the PRE calls, before the narrator | the base floor's state, `{ type, mid, swipe, generationAttempt, preOutputs }` | an event key, or `''` |
| `resolveTurn` | after the narrator's reply is parsed (RES1) | the reply's state, `{ mid, swipe, dice, dicePools, ops, sameRoundEventKey }` | `{ statData, applied, log, resBlock?, textReplacements? }` |
| `resolvePostRelay` | after POST's blocks are applied (RES2) | the reply's state, `{ mid, swipe, dice, dicePools, ops }` | the same as `resolveTurn` |

The base floor is the last reply that has state, before the player's message.

Rules for every hook:

- **Every call crosses into the sandbox as a copy,** both ways. Return the state you changed. Changing the argument alone changes nothing.
- **A hook can be `async`.**
- **A call has no time limit.** Only loading the engine times out, after 10 seconds.
- **Only top-level function exports can be called.**

## preAssemblyPatch

Your engine's own writes, before the prompt is built. Use it for a value PRE and the narrator must already see this reply: a counter, a clock step, where someone is.

ArtificKoi uses it to place the heroines who are not in the scene. For each one whose stored location differs from where the calendar puts her, it returns one `replace` of `/Classmate/<Key>/Location/0`. If nobody moves, it returns `[]`. So by the time the narrator writes, everyone is already where the calendar says.

How it works:

- `statData` is the base floor.
- Return JSON Patch ops (`add`, `replace`, `remove`, paths starting with `/`), or `[]` when nothing changes. A broken op is dropped.
- MVU Helper applies them to the player's message (`ctx.mid`) through MVU and saves them, so PRE and the narrator read the result.
- It runs on every story turn, whether Extra LLM Calls is on or not. `ctx.type` is `'normal'`, `'regenerate'` or `'swipe'`. Continue, quiet and impersonate are not turns, so nothing runs for them.
- It runs before PRE, so it can't see this turn's PRE verdicts. Anything that needs them belongs in RES1.

**What happens on a regenerate.** MVU Helper first puts back every path the previous attempt wrote on that message. Then it calls the hook again with the same base floor, the same `type`, `mid` and `swipe`. So a value worked out from the base floor lands the same on every attempt.

It's like retaking a photo. Everyone goes back to their mark before each shot, so the second shot starts exactly where the first one did.

What does change is `ctx.generationAttempt`. It goes up on every generation, background quiet ones included. Want a fresh result each time the player re-rolls, like a new encounter after a bad one? Fold `generationAttempt` into your seed. Want the same result every time? Ignore it.

## pickSameRoundEvent

Lets an event play in the reply it becomes ready in, instead of the reply after.

Take the Megumin restaurant event from the [README](../../README.md). You walk into the restaurant after everyone refused to join your party. Without this hook, Megumin shows up in the reply after. With it, she shows up in this reply.

How it works:

- It runs when Extra LLM Calls is on and at least one PRE call ran.
- `ctx.preOutputs` is every PRE call's raw output, `[{ name, output }]`. `statData` is the same base floor those PRE calls read.
- Return the key of the event to play now, or `''`.
- Deciding the key is entirely yours: what PRE was shown, which field of its output carries the verdict, and whether the key it names is one you actually offered. In ArtificKoi, a PRE call returns an `eventReady` field, and `pickSameRoundEvent` reads it from `ctx.preOutputs`, but only accepts a key PRE was offered this reply.

Then MVU Helper plays it:

1. It finds the `@<key>` gated body in your card's lorebook and renders it.
2. It gives it to the narrator, with the instruction to report `/Intent/eventFire` for that key.
3. It hands the key to `resolveTurn` as `ctx.sameRoundEventKey`. Whether the event really fired is yours to judge.

A return that isn't a string plays nothing, and is warned.

## resolveTurn and resolvePostRelay, the fine print

**When `resolveTurn` runs.** Once per reply, after MVU has parsed the narrator's reply. A regenerate or a swipe is a new reply. Updates that are not the reply itself don't call it: an older message MVU replays, a PRE patch, a plugin's write or a status menu button.

**`ctx.ops`** is every state change parsed this generation, as `[{ path, old, new, by }]`. Paths are dotted, like `Mainchar.Money`. `by` says who made it: `message`, `pre-sim`, `post`, `plugin:<id>`, `statusmenu:<id>` or `host`. Your own changes never show up. It holds at most 500 entries. In `resolvePostRelay`, it also holds POST's changes (`by: 'post'`).

**`ctx.dicePools`** is the dice per pool, `{ pool | hash, sides, dice }`. `ctx.dice` is the same dice, flat. Both are `null` when no dice were dealt. See [Dice](runtime.md#dice).

**`applied`.** MVU Helper only saves when it's `true`. It also skips the save if the chat moved on while your engine ran, like a new turn or a swipe.

**`log`** prints as one `[mvu-helper] [logic-engine] [RES]` line, when the Pipeline debug domain is on.

**`resBlock`** is only the body. MVU Helper wraps it in `<RES_Variable>` and writes it into the reply: after the narrator's `</UpdateVariable>`, else before the status menu placeholder, else at the end. `resolvePostRelay`'s goes in `<RES_POST_Variable>`, right after `<RES_Variable>`. Don't write the tags yourself.

**`textReplacements`** is `{ find: replace }` pairs, applied to the reply's text as literal text, not regex. A pair whose value isn't a string, or whose key is empty, is skipped with a warning. ArtificKoi fills `<DateAndTime/>` and `<location/>` in the reply this way.

**If it throws,** the reply isn't resolved. MVU Helper logs the error and shows a toast.

[Back to How a GameLogic Engine works](technical.md) · [Back to index](../../README.md)
