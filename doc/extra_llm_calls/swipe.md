# Swipe, regenerate, stop and delete

> This page applies to any card. ArtificKoi shows up as a real example, not as a rule.

With 1 LLM call per reply, a swipe is simple: throw the reply away, write another. With 3, it's not. PRE already wrote to the save before the narrator started. POST may still be running when you swipe. And every one of them takes seconds, during which you can stop, regenerate or delete anything.

PRE, the narrator and POST all have to agree on which reply they're working on, every single time. This page is every trick MVU Helper uses to make that true. You don't have to do anything for any of it. It's here so you know what you can count on.

## Not every generation is a turn

SillyTavern generates for more than story turns. Continue, impersonate and quiet background calls, like the Summarize extension's, are generations too.

None of them runs PRE, POST or `preAssemblyPatch`. A quiet call isn't your turn. Impersonate writes YOUR line, so there's nothing to judge yet. And Continue extends a reply that was written against this turn's PRE verdict. Running PRE again could hand the second half a different verdict than the first half already played, because a small model doesn't answer the same way twice.

So a Continue keeps the verdict that's already in the save, and the dice it already spent.

## PRE reads from before your line

PRE writes to the message your line is on. So if PRE also read from there, a regenerate would read attempt 1's writes, and attempt 2 would build on them. Every regenerate would push the state a little further. That's a ratchet.

So PRE always reads the base floor: the last reply with state before your line. EJS1 and every other PRE read are pinned there. Attempt 2 starts from exactly where attempt 1 started.

It's like retaking an exam question. You start from the question, not from the answer you crossed out.

## A regenerate puts back exactly what PRE wrote

PRE's writes from attempt 1 are still on your line's message when attempt 2 starts. Wiping the whole message would be wrong too, because you might have edited a value there yourself.

So MVU Helper keeps an undo record per message and per swipe: every path PRE wrote, and what it held before. A new attempt first puts back exactly those paths, and nothing else. Your own edits survive. The console names what it put back:

```
retry: reset 2 path(s) the last attempt wrote (/World/Weather, /Intent/check)
```

The undo records are cleared when you switch chats. Message numbers repeat across chats, and one chat's undo put back onto another would be corruption.

## A swipe writes 2 messages

On a swipe, the narrator's prompt is built from a copy of the latest reply's variables, taken before PRE ran. So PRE writes there too, not only on your line. Without that second write, PRE's note would say one thing, and the state the narrator sees would say another.

## PRE's write checks the chat first

A PRE call takes a few seconds. By the time it answers, the chat may have moved. So right before writing, MVU Helper checks again, and drops the write, naming why, when:

- you stopped the generation,
- a newer generation started,
- your line's message is gone,
- your line is no longer the latest one.

A dropped write changes nothing. It's logged, and the turn goes on.

## PRE's note is never saved

PRE's prose goes into the copy of the chat built for one prompt, and that copy is thrown away right after. It's never in the saved chat, and never in a swipe.

So every swipe gets its own PRE, and its own note. No swipe ever carries a stale verdict from another one.

## The macros are swipe-safe

`{{mvuhelper::history}}` and `{{mvuhelper::userLine}}` read what the narrator actually read for THIS swipe.

SillyTavern's `{{lastCharMessage}}` and `{{lastUserMessage}}` read the live chat instead. On a swipe, that's the reply you just threw away. That's why MVU Helper warns when it finds them in a call's entries.

## POST only records real replies

SillyTavern says "a reply arrived" for more than generated replies. A new chat's greeting and an imported message say it too. POST runs only after a real generation started, so those are skipped.

## Stop halfway, and POST stays out

When you stop a reply mid-stream, SillyTavern still says the reply arrived, with the half you got. POST knows you stopped, and skips it. A half reply never gets recorded as if it happened.

## Delete it while POST runs, and POST writes nothing

If the reply POST was called for is gone by the time it looks, because of a delete, a reload or a dropped connection, POST stops. It never falls back to an older reply. That reply already had its turn, and recording it again would apply its records twice.

## POST checks the turn before it writes

POST takes seconds too, and you can swipe or send the next message meanwhile. So POST remembers which reply and which swipe it started on. Right before writing, it checks again. If you swiped away, or a new turn started, POST adds nothing more: no receipt, no state, no stat box refresh. Writing then would put this reply's records into another message.

## POST waits for the right RES1

POST waits for RES1 to settle the reply first, and the signal it waits for is tied to this exact message and this exact swipe. A RES1 from another swipe never lets POST start early.

## Old replies replayed after a delete aren't new turns

After you delete a message, MVU re-reads older replies to rebuild the state. Each re-read fires MVU's update event, the same event a finished turn fires.

MVU Helper only treats an update as a turn when it starts from one of the 2 newest saved states. So the replay rebuilds the state, and your engine doesn't resolve 20 old replies as if they were new.

## Your engine can tell attempts apart

`preAssemblyPatch` and `pickSameRoundEvent` get `generationAttempt` in their context. It changes on every regenerate and every swipe, and stays the same within one attempt. An engine that rolls dice can fold it into its seed, so a regenerate is a real reroll, instead of the same roll again.

Basically, a swipe, a regenerate or a delete always lands all 3 calls on the same reply, and nothing from a reply you threw away leaks into the one you kept.

[Back to How Extra LLM Calls work](technical.md) · [Back to index](../../README.md)
