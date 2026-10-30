# small-llm — the PRE and POST passes

The Extra LLM Calls feature runs cheap side-calls around the main reply: **PRE** calls before the
narrator writes, **POST** calls after it. Each call is a connection profile plus the lorebook entries
routed to its name (`[<callName>] …`).

It is a generic pipe. It names no card's variables, state roots or `/Intent` channels, and it decides
nothing about any game. When a decision is about the game, the card's logic engine makes it through a
documented hook, and this feature carries the result.

## Files

| File | What it holds |
|---|---|
| `index.js` | the feature's public API (barrel) |
| `extra-llm-calls.js` | the host glue: the PRE interceptor, the POST pass, the writes |
| `extra-llm-calls-core.js` | the decisions, pure and unit-tested in `tests/extra-llm-calls-core.test.js` |
| `extra-llm-calls-ui.js` | the Extra LLM Calls tab |
| `call-input-macros-core.js` | the `{{mvuhelper::…}}` macros a call's entries may use (`devdoc/call-input-macros.md`) |
| `turn-phase-signal.js`, `turn-phase-signal-core.js` | the event saying a PRE or POST pass is in flight |

## PRE — before the narrator

It runs inside SillyTavern's generate interceptor, so the reply waits for it. Story turns only: a
Continue, a quiet or an impersonate generation runs none of it.

1. The logic engine's `preAssemblyPatch`, if it exports one, writes its deterministic state first.
2. The PRE calls run. They read the state of the **base floor**: the last reply with state before the
   user's line.
3. A call that emits `<JSONPatch>` is a sim. Its patch is validated and applied now, on the user's
   floor, so the narrator already writes from the result. The raw patch never reaches the narrator.
4. Each call's text is injected onto the user's line in the prompt copy only, as `[name] … [/name]`.
   It is never saved into the chat.
5. **Same-round firing.** The logic engine's `pickSameRoundEvent`, if it exports one, gets the PRE
   outputs and the state they read, and names an event to play in this reply, or none. This feature
   then finds that event's `@key` body in the lorebook, injects it with the `/Intent/eventFire`
   instruction, and tells RES which key it played. Which event plays, and why, is the engine's call
   (`devdoc/event-pack-engine.md`).

## POST — after the narrator

1. It reads the finished reply minus every patch block in it, wrapped or bare, so a call never copies
   a patch that already landed.
2. When a game engine is active, it waits for RES to resolve the reply, so the calls' templates show
   the resolved state. MVU parses every reply, so RES resolves every reply there; with no game engine
   nothing would arrive, and it does not wait.
3. The POST calls run. Each may emit `<UpdateVariable>` blocks.
4. The blocks are applied through MVU's own parse (`Mvu.parseMessage`), which fires the update event
   the engine's RES2 resolves on. MVU's direct setter is not enough: it writes the value but never
   fires that event, so the record would sit unconsumed.
5. The blocks are written into the reply as `<POSTUpdateVariable>`, after the narrator's own block and
   above the stat menu, with RES's audit blocks after them. The text write is the player's receipt and
   lets MVU rebuild state from the chat; it is not the apply. A card should hide these blocks from the
   narrator's prompt with a prompt-only regex: a narrator shown them copies them, and MVU applies a
   `<JSONPatch>` wherever it sits.

The reason behind each step is in the code comment at that step. `devdoc/editing-a-finished-reply.md`
covers writing into a finished reply.
