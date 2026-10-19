# What is GameLogic Engine

The GameLogic Engine is the heart of MVU Engine v2. It is the game.

It's a JavaScript file you write, and it holds your game mechanics and game logic. What a stat means. How damage is worked out. When a girl agrees to a date. What time it is. When an event fires. All of that lives in the engine, not in the prompt.

Every reply, MVU Helper hands your engine 2 things: the game state, and the narrator's report of what just happened. Your engine decides the result, does the math and hands back the new state. MVU Helper saves it.

The narrator never does this work. It writes the story and reports what happened, nothing more. Your engine does every calculation and every decision. That's the observer and the brain from the [README](../../README.md).

And since it's code, it can be any game. RPG, slice of life, zombie hunting...anything you can write rules for.

## One reply, from the engine's side

Say the player types "I swing my sword at the goblin."

The narrator writes the fight scene. At the end of the reply, it reports what happened in a fixed format:

```xml
<UpdateVariable>
  <JSONPatch>
    [ { "op": "replace", "path": "/Intent/attack", "value": "goblin" } ]
  </JSONPatch>
</UpdateVariable>
```

That's the narrator saying "the player attacked the goblin". No damage, no HP, no math. `/Intent/attack` is a report channel you define for your game.

Then MVU Helper calls your engine's `resolveTurn`. Here's a small one:

```js
const ENGINE_VERSION = 'v0.1.0';   // your engine's version
const ENGINE_NAME = 'my-rpg';      // which game this is
const ENGINE_TYPE = 'rpg';         // which family of games it belongs to

function resolveTurn(statData, ctx) {
    const target = (statData.Intent || {}).attack;        // who the narrator says got hit
    const mob = (statData.Mobs || {})[target];
    const die = ctx.dice && ctx.dice[0];                  // the D20 rolled this reply
    if (!mob || !die) return { statData, applied: false, log: [] };   // nothing to resolve

    const hero = statData.Hero;
    const damage = Math.max(0, Math.floor(hero.STR / 5) + hero.Weapon + die - mob.Armor);
    mob.HP = Math.max(0, mob.HP - damage);
    statData.Intent.attack = '';                          // the report is used up

    return {
        statData,
        applied: true,
        log: [`attack ${target}: ${damage} damage`],
        resBlock: `${target} takes ${damage} damage, ${mob.HP} HP left`,
    };
}

module.exports = { ENGINE_VERSION, ENGINE_NAME, ENGINE_TYPE, resolveTurn };
```

In plain English:

- `statData` is your game state, everything MVU tracks for this game: the hero, the mobs, the reports.
- `ctx.dice` is the dice MVU Helper rolled for this reply.
- The engine reads the report, finds the goblin, works out the damage with your formula, takes it off the goblin's HP and clears the report.
- It returns the new `statData`, and `applied: true` tells MVU Helper to save it.
- `log` goes to the console, for you.
- `resBlock` is the receipt the player sees in the reply.

With 50 STR, a +5 sword, a 14 on the die and a goblin with 10 armor, that's 10 + 5 + 14 - 10 = 19 damage. A goblin with 30 HP is down to 11.

So this reply, the player sees the receipt: goblin takes 19 damage, 11 HP left. Next reply, EJS shows the narrator the goblin's 11 HP, and the narrator writes a goblin that's barely standing.

## Why put the game in an engine

**It cuts the tokens, a LOT.** Every rule you write as prompt instructions costs tokens every single reply. The same rule in code costs zero. In the School genre, putting everything JavaScript can handle into code cut it down to 1/5 of its original size.

**It's 100% deterministic.** The narrator is only an observer. It doesn't do any calculation, and almost no judgment calls. It just reports what happened in a fixed format, and your engine decides the result. Same state, same report, same die, same result. Every single time.

**You can test it without an AI model.** Your engine is plain JavaScript, so you can run it in Node with a made-up state and a made-up report, and check the numbers. No AI model, no SillyTavern, no tokens. ArtificKoi's engine has a test suite that plays full turns this way, and it fails if any number is off.

**Really complex game logic runs right on SillyTavern.** ArtificKoi's School engine reads 24 different report channels every reply and resolves them in a fixed order: new characters, skill checks, the calendar, where everyone is, events, the clock and the weather. That's plain SillyTavern, no standalone app.

**The LLM never gets the whole engine to digest.** EJS hand picks which game mechanics this scene needs (see [What EJS does](../mvu_squad/README.md#what-ejs-does)). Your card's EJS can even ask the engine directly: every function your engine exports is on the page as `LogicEngine.<name>`. School's windows ask the engine which events could happen right now, with `await LogicEngine.sweepCandidateLines(sd)`, and show the narrator only those.

**Real D20 dice, rolled in code.** When your card's EJS asks for dice with `MvuHelper.rollPool(...)`, MVU Helper rolls them with the browser's crypto random generator, and every face is equally likely. The model is shown the die, and your engine gets the exact same dice in `ctx.dice`, so a check resolves with the die everyone saw. An LLM asked to roll a D20 isn't rolling anything, it's picking a number it likes. Need the same roll every time, like a scripted boss fight? Give the roll a seed.

## The hooks

MVU Helper calls your engine at fixed points of every reply. Each hook is a function you export. `resolveTurn` is the main one, and every other hook adds one thing your game can do. Don't export it, and your game simply doesn't do that thing.

| Hook | When it runs | In plain English |
| --- | --- | --- |
| `resolveTurn` | after the narrator's reply (RES1) | read what the narrator reported, decide the results, return the new state |
| `resolvePostRelay` | after POST's records are applied (RES2) | the same, for what POST recorded, in the same reply |
| `preAssemblyPatch` | before PRE and the narrator | write what everyone must already see this reply, like moving the clock or placing NPCs |
| `pickSameRoundEvent` | after PRE, before the narrator | pick an event to play in this same reply instead of the next one |

Where each hook sits in a reply is on the [MVU Squad](../mvu_squad/README.md) page.

Your engine also declares 3 names at the top:

- `ENGINE_VERSION` is your engine's version. It's required, and it has to be a plain string on its own line.
- `ENGINE_NAME` names your game. Plugins read it to know which game they're running on.
- `ENGINE_TYPE` names the family of games it belongs to.

## Where it runs

Your engine runs in a locked-down sandbox, not on the SillyTavern page. No network, no DOM, no `import()`. Plain JavaScript works, plus `console`, `crypto` and a few pure helpers. The full story is in the Security point of the [README](../../README.md).

Watch out for one thing. Every call crosses into the sandbox as a copy. So return the state you changed. Changing `statData` without returning it changes nothing.

Loading the engine times out after 10 seconds, so a stuck engine can't freeze your page.

## Getting started

The technical walkthrough, from lorebook entries to `resolveTurn` and `resolvePostRelay`, is on [How a GameLogic Engine works](technical.md).

Start from a blank pack that already works: an engine that exports `resolveTurn`, an example entry, a sample regex and a sample schema. Clone the `mvu-helper-template` branch for a full workspace with a sample of every pack type, or get just the pack from Development tab > Add New Blank Packs. Both are on [Get a starting point](install.md#get-a-starting-point).

Your engine ships inside a GameLogic Pack, together with your card's prompt entries, schema and regexes. You import the pack into the library, then install it to your card.

Basically, the narrator tells the story, and your engine runs the game.

[Back to index](../../README.md)
