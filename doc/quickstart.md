# QuickStart Guide

The game logic engine is built for rapid development with an AI assistant. You tell the AI what game you want, it writes the code, and the game on your screen runs it a second after every save.

That only works because MVU Helper heavily sandboxes the logic engine. Code your AI wrote, and you never read line by line, can only touch 2 things: the game chat and the game's MVU variables. No network, no files, no SillyTavern settings. So vibe coding is safe here. The details are in the Security point of [Why build on top of MVU Helper](../README.md#why-build-on-top-of-mvu-helper-instead-of-coding-my-own-extension).

## Get started in 11 steps to build a game!

1. **Set up the dev environment.** SillyTavern with MVU Helper and the extensions it rides on, Node.js, Git, a Chrome window your AI can see, and the template workspace. Step by step on [Development Environment and Dev Loops](dev_env/README.md).
2. **Check the dev loop runs.** Run `npm run dev` in the folder you cloned, and leave that window open. You should see `[dev] watching …` and `[dev] serving http://127.0.0.1:6620`, then `build #1` with a ✓ next to every pack. A ✗ names what's wrong with that pack.
3. **Check VS Code opened the right folder.** It's the folder you cloned, the one that holds `CLAUDE.md`, `.mcp.json` and `workspace/`. Not `workspace/` itself, or your AI won't find its rules and can't reach Chrome. For the AI, I recommend Claude Code or Codex.
4. **Pick a character card.** Any regular SillyTavern card you want to turn into a game. Load it into SillyTavern.
5. **Open its chat, then turn on the dev loop.** MVU Helper > Development > Artifact dev loop > Watch the local dev server. The pill should say **Connected**. The first time, it asks whether to install the dev workspace on this card, see [What the dev loop does](dev_env/README.md#what-the-dev-loop-does).
6. Have AI in VS Code to read the one of the quick guide for AI (depends on what you are creating) + the quick guide of StatusMenu Engine.
6. Then, you can just start giving instruction in VS code and explain what game logic you want to add into the character card.  I would recommend to add one feature at one time.  For example, if you want to create a dating sim system, you might want to tell AI to amend the status menu to display Affection,  by modifying the layout.json in workspace\statusmenu\layout first.  So that AI would make it visually for you to see on the screen with a affection value.
7. Next step is to add  logic on how to use this stats.  For example, you can tell AI to build a very simple social system, which under what condition would incrase or decrease affection.  You can name all the scenerio how would increase or decrese affection by talking or taking different action with the girl.   Most likely you will talk to AI back and forth to work out the detail.
8. One thing you will need to remember is that the prose (we called that 'narrate' in most of our doc) is an observor.  It would only report what happened in the prose in a structural format.  It won't do any variable update or any judgement.  Then, the gamelogic engine will parse the structural format reported and execute the real calculation to update affection.   This is to keep narrate simple enough even local model can still run a game, and leave all the heavy lifting to the gamelogic engine in coding.  That means you will have to decide what action need to report back to the gamelogic engine that should matter to affection.
9. Since you are on dev loop, any change in VS code will automatically updated to mvu-helper.  You just generate 1 reply and talk to a girl and see if you logic works and increase the affection.
10. If it works, rinse and repeat from step 6 to 9 to add more logic into the game.

That's it. Now every file your AI saves in `workspace/` lands on that card by itself.

## Quick guides for AI

These 4 pages are written for your AI, not for you. They're short, strict and full of file paths, because that's what an AI codes best from.

Point your AI at the one for what you're building. Something like: "Read the GameLogic Engine quick guide, then build a game logic engine for this card."

- [Quick guide for AI - GameLogic Engine](ai_guide/gamelogic_engine.md)
- [Quick guide for AI - GameLogic Plugin](ai_guide/gamelogic_plugin.md)
- [Quick guide for AI - StatusMenu Engine](ai_guide/statusmenu_engine.md)
- [Quick guide for AI - EventPack Engine](ai_guide/eventpack_engine.md)

[Back to index](../README.md)
