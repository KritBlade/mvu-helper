# What is GameLogic Plugin

A GameLogic Plugin is a small add-on you install onto a game card. It adds one feature to a game it didn't write: weather, a diary, a travel map, anything that makes sense on more than one game.

It works like a mod for a PC game. The modder never needed the original developer to change a line, and the game's own files stay the way they were. Same here. A plugin never touches the game's GameLogic Pack. It sits next to it.

And it doesn't even need a game. A plugin can run on a card that has nothing but MVU and MVU Helper.

## What a plugin brings

- **Prompt entries.** What the models read, same as the game's own entries.
- **Its own drawer.** One spot in the game state that belongs to the plugin. Nothing else writes there.
- **Its own code, if it wants.** A small JavaScript file that runs once every reply, after the game is done with it.
- **A side panel slot, if it wants.** One box in MVU Helper's side panel, to show what it keeps.

## One reply, from the plugin's side

Say you made a Weather plugin, and the player installs it on a card you've never seen.

1. **Before the narrator writes,** the plugin's entry asks the card what day it is. It rolls a die against that month's odds, and tells the narrator: sunny today.
2. **The narrator writes the scene** in the sun. It never did any math. It just read one line.
3. **After the reply,** the plugin's code reads the same die, works out the same weather, and saves it in the plugin's drawer. So every reply that day reads the same weather.

The game itself never knew any of this happened. It didn't have to.

## 2 kinds of plugin

**Game-bound.** It needs a game that offers certain things, like a cast or a clock. Install refuses it on a card that doesn't offer them, and says which one is missing.

**Standalone.** It needs nothing. It runs on any card, game or no game. And on a card that does have a game, it finds more there, with no change to its file.

It's like a DLC and a game controller. A DLC needs its base game. A controller works on any console.

## How it finds its way in a game it never saw

A plugin is written once, and lands on games its author never played. So it asks 2 questions, and never guesses:

- **Which game is this?** Every game engine declares its own name. A plugin that knows a game can do more on it, by name.
- **Where does this game keep the thing I need?** The game publishes a short list: my cast is here, my clock is there. That's `exposes`, and it works like a mall directory. See [Exposes](../gamelogic_engine/exposes.md).

The Weather plugin asks for the clock. On a game that publishes one, you get weather. On a game that doesn't, the plugin says nothing instead of guessing.

## A guest in someone else's game

The game decides every outcome. A plugin keeps its own state in its own drawer, reads the game's state, and adds its prompt text next to the game's.

Can it write somewhere else? Technically, yes. An installed plugin can write anywhere the card's schema allows. Installing a plugin is the player's decision to trust it, the same way you only install mods you trust.

But a good plugin doesn't. It's like staying at a friend's place. You could open every drawer in the kitchen. A good guest uses the guest room, and asks when they need something. A plugin that wants the game to change asks the narrator in prose, and lets the game record it by its own rules.

## What it costs

A plugin can talk to the models in 3 places:

- **The narrator's prompt.** Free. It rides on the main model, no extra call.
- **A PRE call,** before the narrator. One extra LLM call, unless it shares the game's.
- **A POST call,** after the reply. Same as PRE.

Sharing the game's PRE and POST calls is the usual way, so a small plugin costs nothing extra. What these calls are is on [MVU Squad](../mvu_squad/README.md).

## Where its code runs

A plugin's code runs in the same locked sandbox as the game engine. No network, no access to the SillyTavern page. It can't even call the game engine's functions. It only reads the state and hands back changes. The full story is in the Security point of the [README](../../README.md).

If a plugin's code crashes, only that plugin's changes are dropped. The game and every other plugin keep going.

## Getting started

The technical walkthrough, from the plugin file to its code, is on [How a GameLogic Plugin works](technical.md).

The [template workspace](../gamelogic_engine/install.md#the-template-workspace) comes with 2 sample plugins that already work. Or start a blank one from MVU Helper > GameLogic Packs tab > Add New Blank Packs > GameLogic Plugin.

Basically, the game runs the game, and a plugin adds one more thing to it, on any card that can use it.

[Back to index](../../README.md)
