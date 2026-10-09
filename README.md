# MVU Helper

**Development Features**

- [What is Tavern Helper, ST-Prompt-Template and MVU](doc/st_extensions/README.md)
- [Development Environment and Dev Loops](doc/dev_env/README.md)
- [MVU Squad](doc/mvu_squad/README.md)
- [What is GameLogic Engine](doc/gamelogic_engine/README.md)
- [What is GameLogic Plugin](doc/gamelogic_plugin/README.md)
- [What is Status Menu Engine](doc/statusmenu_engine/README.md)
- [What is EventPack Engine](doc/eventpack_engine/README.md)
- [MVU Status Menu Builder and DSL Language](doc/statusmenu_builder/README.md)
- [Side Panel](doc/side_panel/README.md)
- [Stat Box](doc/stat_box/README.md)
- [Macros and API](doc/macros_api/README.md)

**User Facing Features**

- [Auto Image Generation](doc/image_gen/README.md)
- [Roster](doc/roster/README.md)
- [Extra LLM Calls](doc/extra_llm_calls/README.md)

## What is MVU Helper

MVU Helper is a SillyTavern extension that lets you build a game inside a character card. Not a bot, a game.  Only 3 functions are end users facing as the table above shown,  the rest of the extenion is mainly for development use.  **If you are normal users, please click the "User Facing Features above"**.
 
I built it to close a gap. I want a vibe coder to be able to build their own game engine and put 3 things right into the character card:

- **Game logic.** Rules that turn stats into results. A warrior with 50 STR hits the same goblin for the same damage every single time.
- **Game content.** The story the content creator wants you to play. If you make a Konosuba game, you meet the same cast and fight the same bosses in the same order as the show.
- **Event triggers.** Checkpoints with conditions. When your level is over 30 and quest step 2 is completed, a dragon starts roaming in a dungeon far east. Between checkpoint A and B, you can still do whatever you want.

Game Logic - For example, you have a lorebook entry that is a warrior called Hero with 50 STR, 30 CON, 15 INT. The AI model does NOT know how to translate these stats into damage. When you add weapon and armor on top of these stats, the AI just randomly makes up numbers when you hit a mob. So, reply 5 and reply 40 can have completely different damage with the same stats. A slice of life/dating game will also have the same problem. Bonding 30, Affection 40, Jealousy 35 have no meaning to the AI model. It will randomly generate the behavior of the girl, and her behavior and personality could be completely different from turn to turn. Does Affection 45 allow you to kiss? The AI doesn't know. This is Game Logic.

Game Content - If you want to make a Konosuba game and want to play as the main cast to experience the same story and fight those bosses in the same order, you can't do that with a plain lorebook. There is no way to track the state, nor a way to trigger events. AI can generate random content, but it will not know how to generate the correct content and events in the correct order at the correct time. This is game content.

Event Trigger - When you first come to the town with Aqua in Konosuba, you are supposed to meet Megumin in a restaurant after numerous people refuse to join your party. This is an event triggered after you are in the restaurant and after numerous people refuse to join your party. You can't do this kind of event triggering with prose alone in SillyTavern. This is an event trigger.

MVU Helper rides on [MVU (MagVarUpdate)](https://github.com/MagicalAstrogy/MagVarUpdate), the stat and state tracking framework a lot of Chinese game cards are built on.

### Why a plain lorebook is not enough

Most English character cards are a plain lorebook with a few alt greetings. There are no game mechanics and no game content in them.

An AI model executes instructions. If the lorebook gives it stats but no instruction what they mean, the AI just guesses. Your warrior with 50 STR hits a goblin for 12 damage on reply 5 and 60 damage on reply 50. Does Affection 40 allow a kiss? The AI doesn't know, so it makes something up, and something different every time.

That's the drift. The character you met on reply 5 is not the same character on reply 50.

### Why putting the whole engine in the prompt is not the answer either

Most Chinese game cards do have logic built in. The catch is that the complete engine goes into the prompt every single reply, with all the instructions, the maths and the formulas. That takes a lot of tokens per reply while the game is relatively small, which is expensive.

And on top of that, an LLM is not good at arithmetic. Give it a few numbers and it's fine. Give it a whole game's worth of formulas at once and it starts making mistakes, so it drifts too.

It's like asking a great novelist to do your tax return. They write beautifully. You still don't want them doing your math.

So MVU Helper goes hybrid. The AI does the writing, code does the math. Each one only does what it's good at. The drawback is that the author of the character card will need to do some coding on the logic engine. I have made that simple enough for vibe coding.

### Why build on top of MVU Helper instead of coding my own extension?

You could code your own extension. It just happen that using the MVU Helper could grant you all the following functions without coding 1 single line of code.


**State and stats tracking comes with it.** MVU Helper rides on MVU, so tracking every stat and every state change is already done. That's a LOT less coding and debugging before you even get to your game.

**Multiple LLM calls come with it.** You can run calls before the main reply (PRE) and after it (POST). These are not random LLM calls. Each layer knows exactly what the next layer does, and information is passed from one call to the next, all built in. See [MVU Squad](doc/mvu_squad/README.md).

Think of a relay race. Every runner knows who they hand the baton to, and nobody drops it. Getting that hand-off right was a nightmare when I built MVU Helper. You don't need to debug any of it.

**You focus on the game only.** Game logic and game rules, that's your part. How your logic talks to SillyTavern is already handled, so you never need to worry about it.

**GameLogic plugins come free.** Other devs can add new functions and content to your game through the plugin system, without you changing one single line of code. A weather plugin for an RPG logic engine, for example. See [What is GameLogic Plugin](doc/gamelogic_plugin/README.md).

**The status menu is click and drag.** You build the in-game GUI in [MVU Status Menu Builder](doc/statusmenu_builder/README.md) with a click and drag interface. If your status menu also needs to update variables, a little coding is required, but the API call is already built, so you don't write your own. See [Macros and API](doc/macros_api/README.md).

**The EventPack engine comes free.** Other content creators can add new events and story to your game, again without you changing one single line of code. See [What is EventPack Engine](doc/eventpack_engine/README.md).

Plugins and event packs work like mods for a PC game. The modders never needed the original developer to change a line. Basically, the end user can download a plugin or an event pack from some other 3rd party content creator and install it right inside MVU Helper, that's it.

**Security is built in.** The logic engine is built for vibe coding, and that means you will run engine code you didn't write line by line, sometimes from a card somebody else shared. So I locked it down. I did numerous fixes, plus PRs to MVU and ST-Prompt-Template, just to make sure whatever is inside a logic engine can't read or write anywhere except the 2 places I specified: the game chat and the game's MVU variables. The game logic engine is heavily locked down.

The logic engine inherits NOTHING from the parent page except the chat and the MVU variables. It has no network access at all. No `fetch`, no `XMLHttpRequest`, no `WebSocket`, no `import()`, no reading or writing SillyTavern's settings files.

JavaScript functions are on an allowlist too. Plain JavaScript still works (Math, JSON, Date, arrays and so on), plus a few pure helpers like `structuredClone`, `atob` and `btoa`. Pretty much everything else is blocked except `console.*` and `crypto.*`. That sounds limiting, but ArtificKoi, as complicated as it is, was built without any other exotic JavaScript functions. If your engine needs another pure helper, just ask. Network, storage and DOM will never be allowed.

Even the schema a pack installs is filtered. The schema runs on the page as a Tavern Helper script, so before it installs, MVU Helper cuts it down to an allowlist. It can declare a Zod schema and register it, nothing else. Anything else in it is removed, and a toast tells you which lines.

Therefore, you only build the part that makes your game different. Everything else is already there. Sounds good?

### It's a game, not a bot

A character card built with MVU Helper is not a single character to chat with. It's a game, and that means rules and regulations are enforced.

You can't prose your character into kissing a stranger walking by and expect it to work. Just like in Final Fantasy, you can't beat the final boss at level 1 just because you want to.

### Rules do NOT restrict the prose

A lot of people ALWAYS get this wrong. They think having rules means the AI can't prose freely. That's just not the case. Rules keep the *game logic* consistent, and the prose stays completely free.

Here's the difference. Say you try to kiss her, and the engine says no because her Affection is too low. The AI is completely free in how she turns you down. She laughs it off. She steps back and changes the subject. She slaps you. She pretends she didn't hear. Every one of those is fine. The only thing the AI can't write is her kissing you back.  We just want to set the boundary that AI shouldn't do something stupid and not logical at all.  Most console game works the same way.

Think of a football match. The commentator can describe a goal any way they like, but if the scoreboard says 2-1, they can't call it 3-1. The AI is the commentator. The logic engine is the scoreboard.

### The AI is only the observer

The AI never updates points and never does arithmetic. At the end of each reply, it reports what it just wrote as a short structured command.  Therefore, your story will write exactly the same as without the engine.  The only boundary is the stats of NPC will make the story meaningful.  You can't kiss someone who hate you.  You can't defeat the final boss at level 1.  On the other hand,  you will always defeat the same boss if your stats is high enough, every single time.  At the end of the day, we make the logic deterministic.

Every action becomes an `/Intent`, and that goes to the logic engine. Even if you type "I kissed her", that doesn't make it really happen, unlike a regular SillyTavern character card. Everything you write is an intention. Whether it succeeds or fails is up to the logic engine.

Same as real life, actually. You can try to kiss someone. Whether it works is not up to you.

### The logic engine is the brain

The logic engine takes the `/Intent`, checks the stats of everyone involved, looks up the table or formula the game defines, applies the math, updates the variables and returns the result.

It doesn't judge anything. Think of the barcode scanner at a supermarket checkout. It doesn't care why you're buying something or who it's for. It reads the code, looks up the price and adds it up. The logic engine does the same with the story. It converts the prose into numbers...nothing more.

Basically, the AI writes the story, and the logic engine keeps the score.
