# QuickStart Guide

The game logic engine is built for rapid development with an AI assistant. You tell the AI what game you want, it writes the code, and the game on your screen runs it a second after every save.

That only works because MVU Helper heavily sandboxes the logic engine. Code your AI wrote, and you never read line by line, can only touch 2 things: the game chat and the game's MVU variables. No network, no files, no SillyTavern settings. So vibe coding is safe here. The details are in the Security point of [Why build on top of MVU Helper](../README.md#why-build-on-top-of-mvu-helper-instead-of-coding-my-own-extension).

## Get started in 5 steps

1. **Set up the dev environment.** SillyTavern with MVU Helper and the extensions it rides on, Node.js, Git, a Chrome window your AI can see, and the template workspace. Step by step on [Development Environment and Dev Loops](dev_env/README.md).
2. **Check the dev loop runs.** Run `npm run dev` in the folder you cloned, and leave that window open. You should see `[dev] watching …` and `[dev] serving http://127.0.0.1:6620`, then `build #1` with a ✓ next to every pack. A ✗ names what's wrong with that pack.
3. **Check VS Code opened the right folder.** It's the folder you cloned, the one that holds `CLAUDE.md`, `.mcp.json` and `workspace/`. Not `workspace/` itself, or your AI won't find its rules and can't reach Chrome. For the AI, I recommend Claude Code or Codex.
4. **Pick a character card.** Any regular SillyTavern card you want to turn into a game. Load it into SillyTavern.
5. **Open its chat, then turn on the dev loop.** MVU Helper > GameLogic Packs > Artifact dev loop > Watch the local dev server. The pill should say **Connected**. The first time, it asks whether to install the dev workspace on this card, see [What the dev loop does](dev_env/README.md#what-the-dev-loop-does).

That's it. Now every file your AI saves in `workspace/` lands on that card by itself.

## Quick guides for AI

These 4 pages are written for your AI, not for you. They're short, strict and full of file paths, because that's what an AI codes best from.

Point your AI at the one for what you're building. Something like: "Read the GameLogic Engine quick guide, then build a game logic engine for this card."

- [Quick guide for AI - GameLogic Engine](ai_guide/gamelogic_engine.md)
- [Quick guide for AI - GameLogic Plugin](ai_guide/gamelogic_plugin.md)
- [Quick guide for AI - StatusMenu Engine](ai_guide/statusmenu_engine.md)
- [Quick guide for AI - EventPack Engine](ai_guide/eventpack_engine.md)

[Back to index](../README.md)
