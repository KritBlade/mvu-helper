# PRE: before the reply

> This page applies to any card. ArtificKoi shows up as a real example, not as a rule.

PRE calls run after you hit send, and before the narrator writes a single word. The reply waits for them. Whatever they decide, the narrator already knows when it starts.

That's the point of PRE. A small model reads your line, makes the judgment call, and hands the answer to the narrator on a plate. The narrator doesn't have to judge anything. It just writes.

## When PRE runs

PRE runs inside SillyTavern's generate interceptor, the step right before the prompt goes out. In this order:

1. Your engine's `preAssemblyPatch`, if it exports one, writes its own state first. A clock step, a counter.
2. Every PRE call runs. With **Run calls in parallel** on, they all fan out at once, and MVU Helper waits for every one of them. Calls on the same connection profile take turns.
3. Every answer lands in `globalThis.mvuHelper.lastPre`, and MVU Helper fires `mvuhelper:pre-done`.
4. Each answer is split in 2: the patch blocks, and the prose.
5. The patch blocks are applied to the save.
6. The prose goes onto your line, in the prompt copy only.
7. Your engine's `pickSameRoundEvent`, if it exports one, can pick an event to play in this reply.
8. The narrator writes.

**Only a real turn runs PRE.** Continue, impersonate and SillyTavern's quiet background calls run none of it, not even `preAssemblyPatch`. A Continue extends a reply that was already written against this turn's PRE verdict, and that verdict is already in the save.

**One call never holds up the others.** A call that fails, or runs past **Call timeout**, counts as empty, and the rest go on.

## The prose: a note for the narrator

The prose part of every answer goes onto your last line, in the copy of the chat SillyTavern builds for this one prompt. Each call's answer is wrapped in its own name:

```
[PRE]
Social check: asking Mitsuki to lunch. She is free, and her affection allows it. Outcome: accepts.
[/PRE]

I ask Mitsuki to have lunch with me.
```

The narrator reads it as part of your turn. And then it's gone. That copy is thrown away the moment the prompt is built.

| Where | Can you see PRE's note? |
| --- | --- |
| the prompt the narrator reads | yes, that's the delivery |
| a prompt inspector, or the `injected onto user message #N` log line | yes |
| your message in the chat | no |
| the saved chat, and its swipes | no |
| the narrator's reply | no. It reads it, and doesn't repeat it |

So PRE feeds the narrator without leaving anything in your chat log.

## The patch: a state write before the narrator

A PRE call whose answer has a `<JSONPatch>` block writes the save. A bare JSON array of patch ops counts too. That's the whole switch. There's no setting for it.

```xml
<JSONPatch>
[ { "op": "replace", "path": "/World/Weather", "value": "sunny" } ]
</JSONPatch>
```

The patch can write any path your Zod schema allows. MVU Helper:

1. **splits** the patch from the prose, before anything else checks the answer,
2. **checks it strictly,** block by block and op by op. A broken block costs that block alone, and a bad op costs that op alone. Each one is named in the console,
3. **applies it now,** to the message your line is on. The reply starts from there, so the narrator writes from the new state,
4. **tells the narrator in plain lines,** like `World.Weather > sunny`, never the raw ops. Every line carries the full path, because the path is the only thing that tells the narrator what the value is.

Why not show the narrator the raw ops? 2 reasons. A narrator that echoes a `<JSONPatch>` gets it applied a second time, because MVU applies a patch wherever it finds one. And machine syntax in a story prompt makes a model write worse, the small ones most of all.

After the write, MVU Helper checks every op against what was actually saved. A path your Zod schema doesn't list is stripped by MVU without a word. MVU Helper catches that, and warns `op(s) did NOT take`, naming the path.

**Prose or patch? Pick by how long it has to live.** Needed for this one prompt only, write prose. Needed by your engine, by EJS, or by a later reply, write a patch. A weather call that decides it's sunny all day writes a patch, so every reply that day reads the same weather.

## No engine runs at PRE time

PRE's patch is a write, not a resolve. Your engine's `resolveTurn` doesn't run on it. If what PRE wrote needs your engine's math, that happens at RES1, after the narrator.

So when PRE records a verdict your engine will need later, put everything the math needs IN the record. By the time RES1 reads it, the state PRE measured against has moved.

**When PRE decides something, PRE writes it.** Don't ask the narrator to repeat a PRE verdict. That puts a model between the decision and its record, and models drift.

## The output check

The call's **output check regex** says what valid prose looks like. It runs on the prose only, after the patch is split out:

- prose that doesn't match is dropped, with a toast, and the narrator runs without it,
- the patch still applies.

A stray `<think>` block or a chatty preamble can cost you the prose, but never the state. And a broken patch costs you the state, but never the prose.

## When PRE comes back empty

A call that failed, timed out, came back empty or failed its output check has nothing to give. MVU Helper names it in the console, and shows a **PRE degraded** toast. The reply still generates, without that call.

If the whole PRE pass crashes, the same thing: a **PRE failed** toast, and the reply generates without it. PRE never blocks your reply.

## Same-round events

After the PRE calls, your engine's `pickSameRoundEvent` gets every PRE answer, and can name an event to play in THIS reply. MVU Helper finds that event's scene in the lorebook, and adds it to the note on your line. So an event can fire the reply its last condition comes true, instead of the reply after.

Which event plays, and why, is your engine's call. See [pickSameRoundEvent](../gamelogic_engine/hooks.md#picksameroundevent) and [Pattern 2](../gamelogic_engine/same_reply.md#pattern-2-an-event-that-fires-the-moment-its-ready).

[Back to How Extra LLM Calls work](technical.md) · [Back to index](../../README.md)
