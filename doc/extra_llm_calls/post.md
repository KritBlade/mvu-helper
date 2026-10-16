# POST: after the reply

> This page applies to any card. ArtificKoi shows up as a real example, not as a rule.

POST calls run after the narrator has finished. They read the reply, and write down what it shows: who showed up, what changed hands, what mattered. Nobody waits for them. The reply is already on screen.

It's like the minutes of a meeting. The meeting happens first. Then someone writes down what was decided, so nobody has to remember it.

## When POST runs

POST starts when SillyTavern says a reply arrived, and runs on its own, without holding SillyTavern up. In this order:

1. **It waits for RES1,** when your card has an engine that resolves turns. POST's entries should show the state AFTER your engine settled the reply, so it waits for your engine's signal, with a 4-second backstop.
2. **Every POST call runs,** the same way as PRE: in parallel, calls on one profile taking turns, each one bounded by **Call timeout**.
3. **Every answer lands in `globalThis.mvuHelper.lastPost`,** and MVU Helper fires `mvuhelper:post-done`.
4. **Patch blocks are written into the reply and applied,** see below.
5. **RES2,** your engine's `resolvePostRelay`, settles them in the same reply, if your engine exports it.

POST only runs for a real reply SillyTavern just generated. The greeting of a new chat, or an imported message, doesn't count.

If the backstop runs out before RES1 is done, POST still runs, and the console says its entries rendered the state from before RES1.

## What POST reads

The finished reply, with every patch block and the stat box taken out, then narrowed by the call's input filter. Plus your OOC commands, in an `<ooc_commands>` block, because POST never reads your line otherwise.

Its entries render against the reply, after RES1. That's EJS3. See [What a call reads](prompts.md).

## The patch: `<UpdateVariable>`

A POST call writes state when its answer carries an `<UpdateVariable>` block with a `<JSONPatch>` inside:

```xml
<UpdateVariable>
  <JSONPatch>
    [ { "op": "add", "path": "/World/ImportantEvents/-", "value": "Mitsuki agreed to lunch." } ]
  </JSONPatch>
</UpdateVariable>
```

MVU Helper then:

1. **renames the wrapper to `<POSTUpdateVariable>`,** so it can be told apart from the narrator's own block. The `<JSONPatch>` inside stays as it is.
2. **writes it into the reply,** right after the narrator's `</UpdateVariable>`. With none, just before `<StatusPlaceHolderImpl/>`. With neither, at the end. That's the player's receipt, and it lets MVU rebuild the state from the chat later.
3. **applies only that block** through MVU's own parse, and saves the result. The parse fires MVU's update event, and that's what wakes up RES2, and every installed plugin's `resolveRelay`.

Why apply the block and not the reply? Applying the reply would apply the narrator's ops a second time. And MVU's direct setter writes a value without firing the update event, so RES2 would never see it. Parsing just the block is the one way that does both.

Without `resolvePostRelay`, POST's changes are still saved, and your engine sees them at the next reply's RES1.

A POST answer with no patch block writes nothing. It just sits in `lastPost`, for whoever wants it.

### Watch out for these

- **The `<UpdateVariable>` wrapper is required.** Patch ops outside one are reported as lost, and not applied. Prose with no patch at all is warned every reply, unless the call is a routed task's target, see [The developer API](#the-developer-api).
- **Write values, not increments.** Use `replace` and direct values, never `+= 10`. Telling someone "set it to 22 degrees" is safe to hear twice. "Turn it up 2" isn't. Or report on an `/Intent` channel, and let your engine work out the real change.
- **Hide `<POSTUpdateVariable>` from the narrator** with a prompt-only regex. A narrator that sees one copies it into its own reply, and MVU applies a `<JSONPatch>` wherever it finds one.

## Reading what PRE said

POST runs after every PRE call has finished, so it can read their answers. 2 ways:

- **In a POST entry,** the macro: `{{mvuhelper::callOutput::PRE}}` gives you what the call named `PRE` answered this turn.
- **In code,** `globalThis.mvuHelper.lastPre`: a list of `{ name, label, output }`, one per PRE call.

Both give you the raw answer. For a PRE call that wrote a `<JSONPatch>`, that's the patch text, before it was checked. By the time POST runs, the patch is already in the save, so read the state instead: `getvar('stat_data.<path>')` gives you the real values.

## POST's time budget

POST runs in the background, but it can't run forever. The reply's last touches, the stat box and the receipts, are held until POST ends, and written all at once.

Each POST call in the longest chain gets one **Call timeout** of the budget. Halfway through a call's share, a **POST slow** toast tells you it's taking long. At the end of the budget, the held touches are written without POST.

## A reply with no POST call

No POST call configured, none routed, or Extra LLM Calls off: the reply still ends the same way. MVU Helper writes RES1's audit into the reply, sets `lastPost` to an empty list and fires `mvuhelper:post-done`. That's what runs your plugins' `resolveRelay`, once, after the reply.

## The developer API

For your own scripts or extensions:

| Member | What it is |
| --- | --- |
| `globalThis.mvuHelper.lastPre` | `[{ name, label, output }]`, this turn's PRE answers |
| `globalThis.mvuHelper.lastPost` | `[{ name, label, output }]`, this turn's POST answers |
| `mvuhelper:pre-done` | fired after `lastPre` is filled, with your line's message index. No reply exists yet |
| `mvuhelper:post-done` | fired once per generated reply, after `lastPost` is filled, with the reply's message id |
| `globalThis.mvuHelper.runLlmCall(call, input)` | runs one call now. That's what **Test** uses |
| `globalThis.mvuHelper.collectLorebookBlock(name)` | the entries a call named `name` would get |

**The llm-task router** is for a feature that wants its own instruction to run on a call the player picks. You register a task, and you get a dropdown (Off, narrate, or any call), your instruction placed in the chosen call's prompt, and that call's raw answer handed back to you. MVU Helper's Roster tab uses it for its "Harvest via" setting.

The answer it hands you is untouched: no renaming, no stripping. A POST call's answer arrives after its output check.

[Back to How Extra LLM Calls work](technical.md) · [Back to index](../../README.md)
