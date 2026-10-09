# What is Tavern Helper, ST-Prompt-Template and MVU

MVU Helper doesn't stand alone. It rides on 3 other pieces, and you need all 3. Tavern Helper and ST-Prompt-Template are SillyTavern extensions. MVU is an extension of Tavern Helper, not of SillyTavern.

- Tavern Helper > a SillyTavern extension. It adds what vanilla SillyTavern can't do: variables stored in the chat, scripts, and a lot of advanced functions.
- ST-Prompt-Template > a SillyTavern extension. It lets you run JavaScript inside a lorebook entry.
- MVU > an extension of Tavern Helper. It keeps your whole game state in one variable, `stat_data`.
- MVU Helper > rides on MVU, and runs the turn around your narrator.
- your GameLogic Engine > the game itself.

## Tavern Helper

Vanilla SillyTavern has no place to keep game state inside a chat. There's nowhere to put "Mia's Affection is 40" so it's still there 100 replies later, attached to the right chat.

[Tavern Helper](https://github.com/N0VI028/JS-Slash-Runner) adds that. It gives SillyTavern variables that are stored in the chat itself, so every chat carries its own numbers.

It also adds a lot of advanced function calls that a vanilla SillyTavern install doesn't have. Scripts that run with a character card. Reading and writing chat messages and lorebooks from code. Listening for things that happen in the chat. Almost every Chinese game card rides on it. Its own docs are [here](https://n0vi028.github.io/JS-Slash-Runner-Doc/).

## ST-Prompt-Template

A normal lorebook entry is plain text. It says the same thing every time it's sent, whatever is going on in the game.

[ST-Prompt-Template](https://github.com/zonde306/ST-Prompt-Template) lets you run JavaScript inside a lorebook entry, as EJS. The entry runs while the prompt is being built, so it can read the game state and decide what to say right now:

```ejs
<% if (getvar("stat_data.Mia.InScene")) { %>
Mia is here. Her Affection is <%= getvar("stat_data.Mia.Affection") %>.
<% } %>
```

In plain English: if Mia is in the scene, the entry tells the narrator she's here and how much she likes you. If she isn't, the entry sends nothing at all. That's how EJS hand picks what each model sees, see [What EJS does](../mvu_squad/README.md#what-ejs-does).

Your card's own entries are rendered by ST-Prompt-Template. MVU Helper uses the same engine to render the PRE and POST blocks, so the EJS you write works the same way in all 3.

**Turn on "Environmental isolation" in ST-Prompt-Template.** MVU Helper requires it, and it needs ST-Prompt-Template 1.17.8.2 or later. A lorebook entry with EJS is JavaScript running on your SillyTavern page. With isolation on, templates run in a sandbox that refuses network requests. It's off by default, so turn it on before you load any card.

## MVU

[MVU (MagVarUpdate)](https://github.com/MagicalAstrogy/MagVarUpdate) is an extension of Tavern Helper, not of SillyTavern. It runs as a Tavern Helper script, and it keeps your whole game state in one variable, `stat_data`.

**Reading and writing state is simple.** Whoever changes the state, the narrator, a PRE or POST call, or your engine, writes it as JSON Patch inside `<UpdateVariable>`:

```xml
<UpdateVariable>
  <JSONPatch>
    [ { "op": "replace", "path": "/Mia/Affection", "value": 45 } ]
  </JSONPatch>
</UpdateVariable>
```

That's "set Mia's Affection to 45". MVU finds the block, applies it and saves the result. `replace` sets a value, `add` adds one, `remove` deletes one, and the path is just where the value lives, with `/` between the parts.

**Every reply carries its own state.** MVU keeps `stat_data` on each message, not once for the whole chat. Swipe a reply and the other swipe has its own state. Delete the last 3 replies and the game goes back 3 replies too. You never have to fix the numbers by hand after a rewind.

**A Zod schema decides what can go into each variable.** You can't write a string into an integer variable. Say Affection is declared as a number. The model writes `"value": "very high"`, and MVU refuses it, instead of letting a word sit where your formula expects a number and break your math next reply.

It works like a web form that won't let you type letters into the phone number box.

The schema is installed as your card's `Scheme` script. MVU Status Menu Builder generates it for you. And the schema a pack ships is filtered before it installs, see the Security point in the [README](../../README.md).

Watch out for one thing. A field that isn't in the schema gets stripped. If you add a new value to `stat_data`, add it to the schema first, or it vanishes the moment MVU saves.

## Where MVU Helper fits in

MVU Helper always needs MVU. It never assumes your card has a game engine, but it always assumes MVU is there.

Everything MVU Helper writes goes through MVU. PRE's patches, POST's records, your engine's new state, a status menu's buttons. So the Zod schema judges every single write, no matter who made it. If the schema doesn't allow it, nobody can write it.

Basically, Tavern Helper gives the chat a place to keep numbers, ST-Prompt-Template lets your lorebook think, MVU keeps those numbers safe, and MVU Helper runs the game on top.

[Back to index](../../README.md)
