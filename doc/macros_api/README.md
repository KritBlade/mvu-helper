# Macros and API

MVU Helper gives your card 2 ways to talk to it. Macros, for the text in your lorebook entries. And an API, for your code.

## Macros

A macro is a word in curly brackets that gets filled in before the AI reads the entry.

If you ever used `{{user}}` in SillyTavern, you already know how they work. You write `{{user}}`, and the AI reads your persona's name. MVU Helper's macros work the exact same way, they just fill in different things.

The one you'll use the most is the history macro. A PRE or POST call can't see the story, it only sees its own entries. So to hand a call the last 2 replies, you put this in one of its entries:

```
{{mvuhelper::history::2}}
```

That's it. The call now reads what just happened, and can react to it.

What the macros can fill in:

- the last few narrator replies, `{{mvuhelper::history::N}}`,
- the user's last message, `{{mvuhelper::userLine}}`,
- what another call answered this turn, `{{mvuhelper::callOutput::<name>}}`, in POST only,
- which game engine the card runs, `{{mvuhelperEngineName}}` and `{{mvuhelperEngineVersion}}`.

A macro with nothing to fill in becomes empty, and the call still runs. On the very first turn, there is no history yet. So write your prompt so empty still makes sense: "If no history is given, treat this as the opening beat."

## API

The API is for code: the EJS in your entries, a Tavern Helper script, your game engine, your status menu. It's a set of functions MVU Helper puts on the page for you.

The 3 you'll meet first:

- **`MvuHelper.engineInfo()`** tells your EJS which game it's in. A plugin made for any game asks this before it does anything.
- **`MvuHelper.rollPool()`** deals dice in code. The narrator is shown the die, and your engine checks the exact same die later. Nobody makes up a number.
- **`LogicEngine.<your function>()`** lets your card's EJS ask your own engine something, like which events could happen right now.

| I want to... | Use |
| --- | --- |
| hand a PRE or POST call the story | `{{mvuhelper::history::N}}` |
| show a POST call what PRE said this turn | `{{mvuhelper::callOutput::PRE}}` in a POST entry |
| show a PRE call what last turn's POST found | POST saves it to the state, PRE reads it with `getvar`, see [PRE and POST reading each other](technical.md#pre-and-post-reading-each-other) |
| know which game this card runs | `MvuHelper.engineInfo()` in EJS, `{{mvuhelperEngineName}}` in plain text |
| roll dice the narrator sees | `MvuHelper.rollPool()` |
| ask my engine something from an entry | `LogicEngine.<your function>()` |
| read what a POST call answered | the `mvuhelper:post-done` event, then `mvuHelper.lastPost` |
| change a finished reply from my extension | hand the edit to MVU Helper, see [Extensions that change a reply](#extensions-that-change-a-reply) |
| check what's installed on this card | `MvuHelper.packInfo()` |
| log the same way MVU Helper does | `MvuHelper.log` |
| read MVU Helper's settings, or flip a debug switch | `MvuHelper.settings` |

## EJS first, macros after

This one trips everybody once.

An entry is filled in 2 steps. EJS runs first, then the macros are filled in. So EJS can print a macro, but it can never read one. To your EJS, `{{mvuhelperEngineName}}` is still the raw text in curly brackets.

Think of a mail merge. You write the letter first, with "Dear {{name}}" in it. The names only go in when the letters are printed. So the letter can't say "if the name is Bob, add a P.S.", because when you write it, there is no name yet.

That's why the engine's name comes both ways. When your EJS has to decide something, use `MvuHelper.engineInfo()`. When the text only has to show it, use the macro.

## Nothing here writes your game

Macros and the API never change your game. Not one of them changes a variable. Your code can set a debug switch, with `MvuHelper.settings.set`, and that's MVU Helper's own setting. And an extension can hand MVU Helper a change to a finished reply's text, see [Extensions that change a reply](#extensions-that-change-a-reply).

To change the game state, your code hands MVU Helper a list of changes, and MVU Helper writes them through MVU, at the right moment, checked by your schema. A PRE call writes with `<JSONPatch>`, a POST call with `<UpdateVariable>`, your engine through its hooks, and a status menu button through an action.

I built it this way on purpose. When a saved value turns out wrong, you want exactly one place to look.

## Status menu buttons that change variables

A button in a builder menu calls an action in your menu engine. The action returns the changes, like "Energy back to full", and MVU Helper applies them. You write what the button means, never how it gets saved.

So there's no API call to write yourself. Your action is a function that returns a list. See [Actions: what a button does](../statusmenu_engine/engine.md#actions-what-a-button-does).

## Extensions that change a reply

MVU Helper touches every reply a few times after the AI finishes it. It adds the pictures, the stat box, the engine's text. And it saves the reply only ONCE, when the turn is done.

So if you write an extension that also changes a finished reply, don't save it on your own. Hand your change to MVU Helper, and it goes out in that same one save.

Saving on your own costs 2 things. The reply flashes one more time. And a copy you read before your extension got busy doesn't have the picture that landed meanwhile, so saving it wipes the picture out.

How to hand it over is on [Editing a finished reply](technical.md#editing-a-finished-reply-from-your-extension).

## Every macro and every call

Every macro, function, event and flag, with where it works and what it gives back, is on [Every macro and API call](technical.md).

Basically, macros fill in text, the API answers your code, and every write goes through MVU Helper.

[Back to index](../../README.md)
