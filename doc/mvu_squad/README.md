# MVU Squad

MVU Squad is how MVU Helper runs one reply. It's not 1 LLM call anymore. It's a team: cheap models before and after your main model, and your game engine doing the math in between.

Your main model is expensive, and it's good at one thing, the prose. So everything else is taken off its plate. A cheap model classifies before the reply, a cheap model keeps the records after it, and code does every calculation.

## Think of a restaurant

The waiter takes your order and writes the ticket before the kitchen starts. That's PRE.

The chef cooks from that ticket. That's narrate, your main model writing the reply.

The cash register rings up what was served. It never guesses, it just adds up. That's RES, your game engine.

After the dish goes out, someone checks what actually landed on the table and writes down anything the register missed. That's POST.

And the ticket printer gives each of them only what they need to see. That's EJS.

Nobody hires a master chef to write tickets. That's why PRE and POST can run on a cheap model. Each one only does one small job.

## The one rule

Anything with a table, a lookup, a formula or a dice rule goes to code. Anything that needs judgment or language goes to an LLM, like judging tone, classifying an action or writing a character's voice.

The models never hand the engine a number. The narrator reports in words, on `/Intent` channels, and the engine turns those words into numbers. Words in, numbers out.

That's what keeps the math consistent. Code gives the same answer every single time, and you can test it without running a model at all.

## One reply, step by step

MVU keeps your game state in `stat_data`. Every step below reads it, writes it, or both.

```
preAssemblyPatch > EJS1 > PRE > pickSameRoundEvent > EJS2 > narrate > RES1 > EJS3 > POST > RES2
```

- `preAssemblyPatch` > your engine's own writes before anything else runs. A clock step, a counter. Optional.
- EJS1, EJS2, EJS3 > right before each model is called, EJS renders that model's view of `stat_data`. The ticket printer. EJS picks only information we want to show to PRE/Narrate/POST for that reply.
- PRE > cheap models read the player's line and classify the situation before the reply.
- `pickSameRoundEvent` > your engine picks an event to play in this same reply. Optional.
- narrate > your main model writes the reply, and reports what happened as `/Intent`.
- RES1 > your engine turns the narrator's reports into numbers and updates `stat_data`.
- POST > cheap models read the finished prose and record what it shows.
- RES2 > your engine settles POST's records in the same reply. Optional.

| Stage | What it is | Cost | Who writes it |
| --- | --- | --- | --- |
| `preAssemblyPatch` | engine code | free | your engine (optional hook) |
| EJS1, EJS2, EJS3 | template code | free | you write the templates, ST-Prompt-Template and MVU Helper render them |
| PRE | cheap LLM | cheap | MVU Helper runs the call, you write its prompt |
| `pickSameRoundEvent` | engine code | free | your engine (optional hook) |
| narrate | your main LLM | expensive | SillyTavern, with your card's main prompt |
| RES1 | engine code | free | your engine's `resolveTurn` |
| POST | cheap LLM | cheap | MVU Helper runs the call, you write its prompt |
| RES2 | engine code | free | your engine's `resolvePostRelay` (optional) |

What each engine hook receives and returns is on the [What is GameLogic Engine](../gamelogic_engine/README.md) page.

## What EJS does

EJS hand picks what information goes to PRE, narrate and POST. Each model gets a short view of `stat_data`, rendered just for it. Not the whole state...only what that model needs for this reply.

There are 3 reasons for that.

**It saves tokens.** Your game might track 30 NPCs. There's no reason to feed the stats of every single one of them in every single reply when only 2 of them are in the scene. EJS sends the 2 who are there.

**Less to read means a better reply.** Less information ALWAYS makes the AI model react better, because there is a lot less to digest before it writes the prose.

Think of a briefing before a meeting. Hand someone a one-page summary and they walk in ready. Hand them the whole company archive and they spend the meeting looking for the one page that matters.

**It works almost like a second memory.** Each view is a snapshot of what matters for that scene, so the prose picks it up without any memory extension. Say you had a fight with Mia 200 replies ago and never made up. That reply fell out of the context long ago. But your card keeps the conflict in her state, so the moment Mia walks into the scene, EJS puts it right back in front of the narrator. She's still cold to you, and the prose knows why.

It's like a nurse reading your chart before walking in. She doesn't remember you from last month. The chart does.

Each model has its own view:

| View | For | Reads the state |
| --- | --- | --- |
| EJS1 | PRE | from before the player's line |
| EJS2 | narrate | for this reply (your card's own lorebook entries, rendered by ST-Prompt-Template) |
| EJS3 | POST | after narrate and RES1 |

Watch out for one thing. Inside the PRE and POST blocks (EJS1 and EJS3), `getvar` needs the full path:

```ejs
<%= getvar("stat_data.Cast") %>   // correct in PRE/POST blocks
<%= getvar("Cast") %>             // empty, there is no top-level variable named Cast
```

## What PRE can write

PRE can hand the narrator a note, change the game state, or both. It's 2 different things, and they land in 2 different places.

The note is the prose part of PRE's output. It goes into the prompt the narrator reads, for this reply only. It's never saved, never shown in the chat and never in a swipe.

The state change is a `<JSONPatch>` block in PRE's output. It's a real write to `stat_data`, saved, and it happens before the narrator runs, so it shows up in THIS reply.

Here's a concrete one. Say you made a Weather plugin. It picks the weather based on the month, and some months have more sunny days than others. While PRE's prompt is built, the plugin's PRE entry rolls a D20 against that month's odds, say sunny on 1 to 14 in July. PRE passes the answer on in its output: sunny today.

The narrator reads PRE's output, so it knows it's a sunny day without doing any calculation or judgment. PRE already did all the dirty work and handed the answer to the narrator on a silver plate.

And the best part: you write the plugin once, and it works on *any* card built on top of MVU Helper that exposes a clock. It asks the card for `clock@1` through `exposes`, reads the month from its `Date`, and never hard-codes one game's paths. ArtificKoi exposes one. More on the [What is GameLogic Plugin](../gamelogic_plugin/README.md) page.

So pick by how long it needs to live. Only needed for this one prompt, write a note. Needed by the engine, by EJS or by a later turn, write a patch. If the sunny day has to last all day, the Weather plugin writes it as a patch, and every reply that day reads the same weather.

There is no switch for this. The output decides. A PRE call whose output has a `<JSONPatch>` block writes state, and one without it doesn't.

One rule from experience: when PRE decides something, PRE writes it. Don't ask the narrator to repeat a PRE verdict. That puts a model between the decision and its record, and models drift.

Also, your engine doesn't resolve anything at PRE time. If what PRE wrote needs the engine's math, that happens at RES1, after the reply.

## What POST can write

POST's output always lands in `mvuHelper.lastPost`, and MVU Helper fires the `mvuhelper:post-done` event, so your own code can pick it up.

If the output carries an `<UpdateVariable>` block with a `<JSONPatch>` inside, it also writes state. MVU Helper writes that block into the reply as `<POSTUpdateVariable>`, so the player can see the receipt, and applies it through MVU.

```xml
<UpdateVariable>
  <JSONPatch>
    [ { "op": "replace", "path": "/World/Weather", "value": "rain" } ]
  </JSONPatch>
</UpdateVariable>
```

If your engine exports `resolvePostRelay`, RES2 settles it in the same reply. If not, POST's changes are still saved, and your engine sees them at the next reply's RES1.

Same as PRE, no switch. If the output has the block, it writes. If it's only text, it writes nothing.

The gotchas:

- **The `<UpdateVariable>` wrapper is required.** Patch ops outside a wrapper are not applied.
- **Write values, not increments.** Use `replace` and direct sets, not `+= 10`. It's like telling someone "set it to 22 degrees" instead of "turn it up 2". If they hear it twice, 22 is still right. Or report on an `/Intent` channel and let the engine work out the real change.
- **Hide `<POSTUpdateVariable>` from the narrator's prompt** with a prompt-only regex. A narrator that sees it copies it into its own reply.

## Where a call gets its prompt

You set up PRE and POST calls in the Extra LLM Calls tab: a name, a phase (PRE or POST) `[callName]` and a connection profile, which is the model the call runs on, usually a cheap one.

And there's no limit on how many. You can have as many PRE and POST calls as you want, each one just needs a connection profile. So PRE can run on Gemini while PRE2 runs on Sonnet, each with its own lorebook entries.

By default, the calls in one phase run at the same time. Calls that share one connection profile still take turns, so a local server with only one slot doesn't choke.

There's no prompt box. The lorebook is the prompt. Every lorebook entry with `[callName]` in its comment or keys goes to that call, sorted by order.

An entry can be disabled on purpose. Disabled only means the narrator doesn't see it. The call still gets it. That's how rule-heavy entries move to the cheap model instead of bloating the narrator's prompt.

Shared content, like a character roster or your schema, goes in a shared group once, instead of being copied into every call. School v4 has a group called `llmshare` for both PRE and POST.

A call that no entry is tagged for is skipped.

All the settings are on the [Extra LLM Calls](../extra_llm_calls/README.md) page.

## Timing you should know

- PRE's state changes show up in this reply.
- RES1's changes are what POST sees, and what the next reply starts from. On a card with an engine, POST waits for RES1 first.
- POST's records resolve in this reply only if your engine exports `resolvePostRelay`. Otherwise, next reply.
- POST doesn't hold up SillyTavern. Each call has a timeout (Call timeout, 60 seconds by default), so one stuck call can't freeze the turn.
- Continue, quiet and impersonate are not story turns. Nothing in the squad runs for them.

Basically, your main model only writes the story. Everything around it is the squad's job.

[Back to index](../../README.md)
