# What is EventPack Engine

An event pack is new story for your game, written by somebody else. A player installs it inside MVU Helper, and your game plays it, without you changing one single line of code.

Event packs are part of MVU Game Engine v2.0, which is built for rapid development and meant for vibe coding. You tell your AI what you want, it writes the code, and the game on your screen runs it a second after every save.

The engine that plays your events runs heavily sandboxed. It can't read, write or reach the network anywhere outside the game chat and the game's MVU variables, and an event pack itself is data, not code. So it's safe even when the worst AI model writes the game. How to start is on the [QuickStart Guide](../quickstart.md).

Think of mods for a PC game. The modder never needed the original developer to change anything. The game opened a few doors, and the mod walks through them.

## Quick start for content creators

You don't need to write any code to make events. You build them by clicking, in MVU Status Menu Builder's **Event Pack** tab.

1. **Get the game card.** Export the MVU character card from SillyTavern, as `.json` or `.png`, with its GameLogic Engine installed.
2. **Upload it.** MVU Status Menu Builder > **Event Pack** tab > **Upload card**.
3. **Make your events.** For each one, click together when it happens (the conditions), what it changes (the effects), and the scene the narrator plays. The builder only offers what that game allows, so you can't pick something it can't do.
4. **Generate and share.** Download the pack text, and share that one file. A player installs it in MVU Helper > **Event Packs**.

That's it. With a card built on the GameLogic Engine, it just works. The builder reads the game's engine, its schema and its starting variables, and fills the pickers with real paths and the real cast. The one thing it needs is an engine that hosts event packs, like ArtificKoi's. A card whose engine opened no doors for them is refused, and the builder says so.

An event pack is built for ONE card. Its events are tied to that card's characters and story. A beach date with Mitsuki means nothing in a fantasy RPG with no Mitsuki in it, so build a separate pack for each game.

Every field, every section of the tab and how to test your pack are on [Build events in MVU Status Menu Builder](builder.md).

## What an event is

An event is a checkpoint with conditions. When every condition is true, the event happens. Until then, you play whatever you want.

Say it's Saturday, it's after 10:00, and Mitsuki's affection is 40 or more. Then Mitsuki asks you to go to the beach with her. On a Friday, nothing happens. With her affection at 30, nothing happens either. The moment all 3 are true, the scene plays.

A plain lorebook can't do this. It has no idea what day it is, or how much Mitsuki likes you. An event pack can, because your game keeps track of all of it.

## How one event plays

1. Every reply, the engine checks every event's conditions against the current state.
2. When they're all true, the event is armed, and its scene goes to the narrator.
3. The narrator plays the scene, and reports that the event happened.
4. The engine checks the conditions one more time. If they still hold, it commits what the event changes: a quest opens, an item lands in your bag, a new NPC goes into the record.
5. The event is marked done. It never fires twice.

Step 4 is the important one. The narrator only says the event happened. The engine is the one that decides it did.

It's like returning something at a store. You say you bought it there. The cashier still checks the receipt before any money moves.

## The prose never changes the state

Only the event's effects change the state. The scene can say anything, and no number moves until the engine commits the event.

So an event that should make Mitsuki like you more doesn't say "her affection goes up" in the scene. The scene plays a moment that earns it, and the event's effects pay it. Same rule as the rest of your game: the AI writes the story, the engine keeps the score.

## The 3 parts

An event pack has 3 parts, and they go hand in hand:

1. **The event pack file.** One block of text with 2 halves. The rules say when each event happens and what it changes. The scenes say what the narrator plays. When you install it, the text goes into the card's lorebook, and the rules go into the MVU variables..
2. **MVU Status Menu Builder's Event Pack tab.** Where you build events by clicking. You upload the game card, and the builder only offers what that game allows. No JSON, no code.
3. **The condition language.** "Saturday, after 10:00" is written in a small language: `Wkd=Saturday & T>=10:00`. The builder writes it for you. You only need it to hand write a pack, or to see what's behind the GUI.

## Why the same grammar lives in 3 places

The 3 parts read the same conditions at 3 different times. The builder writes them. MVU Helper checks them when you install. The engine evaluates them every reply.

If any 2 of them disagree, an event installs fine and never fires, and nobody gets an error. That's why the grammar is copied word for word into all 3, and kept in sync.


## It can't break your game

A pack is data, not code. It can only write where your game opened a door, and only into records it made itself.

So the worst a bad pack can do is an event that never fires, or a write the engine refuses and logs. Your game, your story events and the player's save stay exactly as they were.

## Who does what

- **The game's developer** opens the doors, once: which conditions exist, where a pack may write, and what it may pay.
- **A content creator** builds the pack in MVU Status Menu Builder, and shares one text file.
- **The player** installs it in MVU Helper's Event Packs tab.

ArtificKoi is the first game that hosts event packs. Its own story events run on the same engine as every pack a player installs.

How it all works under the hood is on [How the EventPack Engine works](technical.md).

Basically, the game opens the doors, the pack walks through them, and the engine makes sure nothing walks through a wall.

[Back to index](../../README.md)
