# Where the engine runs

Your engine doesn't run on the SillyTavern page. It runs in a locked-down sandbox, and MVU Helper talks to it from outside.

## The sandbox

The engine runs in a Worker inside a hidden frame. There is no DOM, no network and no `import()`.

What you can use:

- the JavaScript built-ins: `Math`, `Date`, `JSON`, `Promise`, `Map`, `Set`, `Intl`, arrays, typed arrays and so on.
- `console` and `crypto`.
- `structuredClone`, `TextEncoder`, `TextDecoder`, `atob` and `btoa`.

Everything else is blocked, timers included. So no `setTimeout` either. Using a blocked name throws, and MVU Helper logs the first use of each one. Why it's this strict is in the Security point of the [README](../../README.md).

Loading the engine times out after 10 seconds, so a stuck engine can't freeze your page.

## What the engine can ask MVU Helper

Inside the sandbox, `globalThis.MvuHelper` gives your engine 3 things:

- `engineInfo()` > your engine's own name, type, version and pack id.
- `log` > logging, see below.
- `messages` > which messages exist, without their text. `count(role)`, `at(i)`, `latest(role)` and `find({ role, from, direction, skip })` report message numbers, roles and swipes, never what anyone wrote.

## Your card's EJS can call the engine

On the page, `globalThis.LogicEngine` has one `async` function for every function your engine exports. So your card's EJS can ask the engine things:

```ejs
<% const lines = await LogicEngine.sweepCandidateLines(getvar("stat_data")); %>
```

That's ArtificKoi asking its engine which events could happen right now, so the entry only shows the narrator those.

Always `await` it. Every call crosses into the sandbox and back. Exports that aren't functions are not there.

## Logging

`MvuHelper.log` has `error`, `warn`, `lifecycle`, `verbose`, `trace`, `domain(name, level, …)` and `child(tag)`.

- `error` and `warn` always print.
- The others follow the Debug settings on the Main tab.
- `domain` follows that domain's own toggle: `pipeline`, `imagegen`, `roster` or `smallllm`.

Lines print as `[mvu-helper] [engine:game] [<tag>] …`. So this:

```js
MvuHelper.log.child('RES').warn('goblin has no HP');
```

prints `[mvu-helper] [engine:game] [RES] goblin has no HP`.

## Dice

MVU Helper deals the dice on the page, while the prompt is being built. So the model is shown the die, and your engine gets the exact same die later.

Your card's EJS asks for dice with `MvuHelper.rollPool(count, hash, poolName, sides)`:

```ejs
<% const d = MvuHelper.rollPool(1, null, 'check', 20); %>
The D20 for this check is <%= d[0] %>.
```

- It returns an array of dice. 1 to 20 dice, 2 to 1000 sides, 20 sides when you leave it out.
- Ask again with the same pool name and size, and you get the same dice for the rest of that generation.
- Leave `hash` as `null` for a fresh crypto roll. Give it a value, and the dice are seeded: the same hash always gives the same dice. That's how you script a fixed boss fight.
- `resolveTurn` and `resolvePostRelay` get that generation's dice as `ctx.dice` and `ctx.dicePools`, so a check resolves with the die the model was shown.

ArtificKoi uses this to catch a model that makes up its own number. A check reports the die it used, and `resolveTurn` compares it with `ctx.dice`. When they differ, it warns `DIE NOT FROM POOL`.

`Math.random` and `crypto` work inside the engine too, but no model has seen a number made there. Use them only for things the story doesn't show.

## An engine in several files

`engine/` can hold several files. They are joined in `engineOrder` into one script.

ArtificKoi's engine is 3 files: `i18n.cjs` (display labels), `eventpack.cjs` (the shared event library) and `globalLogic.cjs` (the game rules).

It reads like chapters of one book:

- A name declared at the top level of one file is visible to every file after it.
- The same name declared at the top level of 2 files is a SyntaxError, and the whole engine fails to load.
- The last `module.exports` is your engine's API.

## Hosting event packs

Your game can host event packs that other content creators write. Put the shared event library, `eventpack.cjs`, before your engine file in `engineOrder`, and export `EVENT_PACK_ADAPTER` and `EVENT_PACK_FORMAT`. The blank pack's `engine/README.txt` shows the wiring. The rest is on [What is EventPack Engine](../eventpack_engine/README.md).

## Where the engine lives on the card

The install writes your engine into the card's `[MVU_LogicEngine]` lorebook entry. It's disabled on purpose, because it's storage, not prompt text.

MVU Helper loads it when a chat opens and after every install, and only reloads it when the text changed. The LogicEngine tab's "Enable LogicEngine for this card" (on by default) turns it off for one card.

[Back to How a GameLogic Engine works](technical.md) · [Back to index](../../README.md)
