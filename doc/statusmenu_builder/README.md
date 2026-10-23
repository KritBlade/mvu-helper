# MVU Status Menu Builder and DSL Language

MVU Status Menu Builder is a standalone app that runs in your browser. You download one file, open it, and that's it. No install, and no SillyTavern needed to run it.

It builds the parts of a game that are not code: the status menu the player sees, the schema that says what each variable can hold, and event packs that add new story to a game.

## Why a standalone app

A game made with MVU Game Engine v2.0 has a lot of jobs in it. Somebody codes the engine. Somebody draws the status menu. Somebody writes the events.

The person who draws the menu or writes the events doesn't need to read one single line of the engine's code. They only need to know which data is there: which variables the game keeps, and what's inside each one.

Think of a game studio. The artist draws the screens, and the level designer builds the levels. Neither of them opens the engine's source code. They work from a list of what the engine offers.

That's why I built it as its own app. You give it the game's data, and it only offers what that game has.

## What you build with it

- **The status menu.** You draw it by click and drag, and point each cell at a variable. It exports as a StatusMenu Pack. See [What is Status Menu Engine](../statusmenu_engine/README.md).
- **The schema.** You tick the variables your game keeps, and copy the Zod schema it writes. See [Schema](../gamelogic_engine/schema.md).
- **Event packs.** You upload a game card, and build events by clicking. See [What is EventPack Engine](../eventpack_engine/README.md).

## The DSL

Every event condition is written in a small language, the WHEN-DSL. `Wkd=Saturday & T>=10:00 & Aff(Mitsuki)>=40` is one: it's Saturday, it's 10:00 or later, and Mitsuki's affection is 40 or more.

The builder writes it for you. You pick each condition from a list, so you never have to type it. What's behind the GUI is on [The condition language](../eventpack_engine/dsl.md).

## Get started

The builder lives in its own repo, [MVU Zod Status Menu Builder](https://github.com/KritBlade/MVU_Zod_StatusMenuBuilder). Every tab, every button and the order to use them in is on [How to use MVU Zod Status Menu Builder](https://github.com/KritBlade/MVU_Zod_StatusMenuBuilder/blob/main/doc/README.md).

Basically, the engine developer owns the code, and everybody else works in this builder with the data the engine gives them.

[Back to index](../../README.md)
