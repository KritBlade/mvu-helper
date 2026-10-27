# Entries and the 3 windows

> A plugin is written for any game. ArtificKoi shows up as a real host, not as a rule. See [Written for any game](technical.md#written-for-any-game).

A plugin's entry is a normal lorebook entry. The installer fills in the tokens in its `comment` and `content`. Every other field passes through as is, so `order`, `position`, `depth` and the rest mean what they always mean in SillyTavern.

## A call tag picks the window

| Window | How you ask for it | Who reads it | What it costs |
| --- | --- | --- | --- |
| narrate | no call tag, `type: "constant"` | the narrator, directly | nothing, no extra LLM call |
| PRE | `{PRE_CALL}` in the comment | that call's model. Its output then reaches the narrator | one call |
| POST | `{POST_CALL}` in the comment | that call's model, after the reply | one call |

MVU Helper looks for a `[callName]` tag anywhere in the comment or the keys, and ignores case. An entry with no call tag is an ordinary lorebook entry, and lands in the narrator's prompt.

That's where anything you can compute belongs. Sending a number you already have through an LLM call buys you nothing but cost.

Watch out for these:

- **A narrate entry must be `constant`.** A `selective` entry with no keys never shows up at all.
- **A routed entry goes to its call, enabled or not.** Routing reads the comment, not the switch. So keep it out of the narrator's prompt: disable it, or make it `selective` with no keys. A routed entry that SillyTavern would also send to the narrator, enabled and `constant` or enabled with keys, is refused when you validate.
- **Whether a routed entry reaches a model is the call's switch** in Extra LLM Calls. On chat load, a call that won't run while entries are routed to it is named in the console. A call that's on but has no connection profile also raises a toast.

A standalone plugin keeps to **one** window that asks a model for something, narrate or POST. A narrate entry that only shows state, next to a POST entry that records, counts as one. Why is on [A card with no game](any_game.md#a-card-with-no-game).

## A POST block isn't guaranteed every reply

Your POST entry shares one call, and one output, with everything else routed there. The model may spend its output on someone else's instructions. The provider may cut the output in the middle, and the console says `the provider CUT this output…` when it does.

So design for a missing block. A resolver that reads `ops` can record "nothing came this reply" instead of counting twice later. And whatever state you keep has to survive a skipped reply. See [What it receives](engine.md#what-it-receives).

## Write like a guest

Every entry routed to a call is joined into one system prompt. Your entry sits in the same prompt as the game's own instructions. One model reads both and writes one output, and it doesn't know which part taught it what.

So your examples become the game's examples too. Say the game writes its `[value, label]` pairs with `replace`, and your entry shows `add` ops. The model can carry your `add` over to the game's own record. The game's op is then refused, while yours are fine.

It's like 2 teachers sharing one whiteboard. The students copy the style of whatever is on the board, no matter whose lesson it was.

The rules:

- **Keep example ops few.** A long block of yours can take over the call's whole answer.
- **Match the game's verbs on shapes you share.** If the game writes pairs with `replace`, don't show `add` next to it, even for your own keys.
- **Write only your own drawer,** so a borrowed path does no harm either.
- **Don't say "copy this exactly".** The model can't tell that you only meant your block.
- **Say your verbs are yours.** One line telling the model not to carry this block's style into another one.

**Or bind to your own call.** The install dialog lists every call set up for that phase, not just the game's. Point your plugin at a separate call and the 2 prompts never meet. It costs one more LLM request per reply. That's why sharing is the default for a small, well-behaved entry.

Nothing detects this for you. The write that comes out is well-formed, just wrong. The console names refused POST paths, `[POST] N/M op path(s) ABSENT`, but that's a symptom, not the cause.

## PRE reaches the narrator through its output

The narrator never reads a PRE entry. MVU Helper hands every PRE call's output to the narrator's prompt. So a PRE entry shapes the prose only through what its model writes.

**Give a PRE entry that asks for prose its own call.** A game's PRE call often has an output check on its prose (`outputRegex`). The check runs on the prose part. Patch blocks are taken out first and kept either way. Prose that fails is dropped whole, the game's own text included. So a model that obeyed your extra line on a shared, strict call takes the game's PRE text down with it. The console says `the output FAILED the card's output-check regex — dropped as garbage` when that happens.

A PRE entry looks like this:

```jsonc
{
  "comment": "{PRE_CALL} weather pre",
  "content": "…",
  "order": 268,
  "position": "before_character_definition",
  "type": "selective",
  "enabled": true,
  "key": [], "keys": []
}
```

Installed, the comment becomes `[GameLogicPlugin:weather] [PRE] weather pre`. Both halves matter. `[GameLogicPlugin:weather]` is how uninstall finds the entry, and `[PRE]` routes it.

## EJS in your entries

Your entries are rendered with ST-Prompt-Template's EJS before they're sent, so an entry can compute. `<%_ … _%>` runs code, `<%= … %>` prints escaped, and `<%- … %>` prints raw, which JSON needs. How EJS works is on [Tavern Helper, ST-Prompt-Template and MVU](../st_extensions/README.md).

**Read with `getvar('stat_data')`. Never write with `setvar`.** The render works on the live message, so a `setvar` while the prompt is built is saved for real. And the prompt is built more than once per reply.

**Your entry shares one EJS scope with the game's entries.** ST-Prompt-Template joins every entry of one pass into one block of code before it runs it. The passes are the narrator, PRE and POST. So if your entry declares `const helper` at the top, and one of the game's entries in the same pass does too, the whole pass fails with `Identifier 'helper' has already been declared`. The game's entries go to the model as raw template text, along with yours. Raw EJS still reads like prose, so nothing looks broken. The model just answers from the wrong text.

It's worse for a plugin than for a game, because you can't see the game's entries. So:

- **Declare everything inside a block,** like `try { … }` or a function, so the names never reach the top.
- **Give the few names that must be at the top a prefix of your own,** like `_wxLine` in the Weather plugin. Never a bare `_ok` or `helper`.
- **Keep your `if` gates flat.** Sibling `if`s, never an `if` inside an `if`. And no literal `{` or `}` in the text inside a gate. A stray brace there can cut the prompt off.

The Weather entry on [How a GameLogic Plugin works](technical.md#1-the-entry-rolls-the-weather-and-tells-the-narrator) follows all 3.

## Dice: your own pool

```js
const die  = (globalThis.MvuHelper.rollPool(1, null, 'RAIN') || [])[0];   // count, hash, pool name: one d20
const move = globalThis.MvuHelper.rollPool(2, null, 'MOVE', 6);           // the 4th argument is the faces: 2d6
```

`MvuHelper.rollPool` is MVU Helper's dealer. It's on every card MVU Helper runs on, with a game or without, and it answers right away.

**Pass your own pool name.** Pools are separate, so your dice never take a slot from the game's. Ask without a name, or with the game's pool name, and you get the same dice the game's checks use. It's like a card game where everyone draws from one deck. Draw from the game's deck, and you're taking the game's cards.

- A pool is a name AND a face count. `MOVE` in d6 and `MOVE` in d20 never share a slot.
- A pool holds up to 20 dice. A count that isn't a whole number from 1 to 20, or faces that aren't a whole number from 2 to 1000, deal nothing (`[]`), and the log says which one was wrong.
- Passing a `hash` instead deals dice that stay the same across swipes: same count and hash, same dice.
- A pool deals once per generation. Every build of the prompt in that generation reads the same dice.
- **Deal every die your resolver needs in your entry.** The resolver only reads them. A die rolled after the reply is one the narrator never saw.

## Logging

The same logger is on `globalThis.MvuHelper.log` in your entries, and on `MvuHelper.log` in your engine. Every line says who wrote it:

```
[mvu-helper] [card] [weather] …              an entry's line
[mvu-helper] [engine:plugin:weather] …       your engine's line
```

| Call | Prints |
| --- | --- |
| `error(…)`, `warn(…)` | always |
| `lifecycle(…)`, `verbose(…)`, `trace(…)` | when the player's log level reaches that level |
| `domain(name, level, …)` | when that debug domain is on: `pipeline`, `imagegen`, `roster`, `smallllm` |
| `enabled(level)`, `domainEnabled(name)` | nothing. They tell you whether such a line would print |
| `child(tag)` | nothing. It gives you the same logger with one more tag |

On the page, every card script shares the `[card]` source. So tag your entries' lines with `child`: `MvuHelper.log.child('weather').warn(…)`.

## Settings

Your entries and your engine read MVU Helper's settings by name, like `globalThis.MvuHelper.settings.get('debug.pipeline')` for the Pipeline switch. Read them this way, not through `SillyTavern.extensionSettings`, which hands your template every extension's settings just to find one switch, and makes every install of your plugin ask the player first, see [The install warning](../gamelogic_engine/install.md#the-install-warning). The names, and how an entry flips a debug switch, are on [settings](../macros_api/technical.md#settings).

[Back to How a GameLogic Plugin works](technical.md) · [Back to index](../../README.md)
