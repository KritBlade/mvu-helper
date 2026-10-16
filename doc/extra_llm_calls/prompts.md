# What a call reads

> This page applies to any card. ArtificKoi shows up as a real example, not as a rule.

A call has no prompt box. The lorebook is the prompt. Every entry tagged with the call's name goes to that call, and that's all the call knows, unless you hand it more.

A call gets exactly 2 messages:

| Message | PRE | POST |
| --- | --- | --- |
| **system** | the entries routed to it, rendered | the entries routed to it, rendered, plus your OOC commands |
| **user** | your last line | the finished reply, minus every patch block and the stat box |

No chat history, no character card, no preset prompt. A call sees the story only when you hand it over, with the macros below.

It's like briefing a contractor. They don't read your whole email history. They read the brief you wrote, and the one thing they were asked to look at.

## Routing: which entries a call gets

An entry goes to a call when its comment or its keys contain `[name]`, anywhere, in any case. So `[PRE] Social_check_system` goes to the call named `PRE`.

- **Group entries come first.** A call in a shared group gets the group's `[tag]` entries ahead of its own.
- **Sorted by order,** with the lorebook's own order breaking ties, into one system block.
- **Enabled or not, it's routed.** An entry's own switch is SillyTavern's switch: whether the narrator's prompt can include it. So disable your PRE and POST entries in SillyTavern. The narrator never sees them, and the calls still get them.

That last one is the whole trick behind a lean narrator prompt. Rule-heavy entries move to a cheap model at full size, instead of bloating the prompt your expensive model reads.

| ArtificKoi's entry | Goes to |
| --- | --- |
| `CURRENT_VARIABLE_DATA` | the narrator |
| `[PRE] Social_check_system` | the `PRE` call |
| `[POST] Story_Analysis_Detail` | the `POST` call |
| `[llmshare] Classmate_Roster` | both, through the `llmshare` group |

## How the entries are rendered

PRE and POST calls go out through Connection Manager, and that path fires none of the events ST-Prompt-Template listens to. So MVU Helper renders the entries itself, in 3 passes:

1. **EJS,** pinned to one message's variables, so `getvar` reads the right moment:
   - **EJS1, for PRE:** the last reply with state before your line. Not your line itself, which PRE may write to.
   - **EJS3, for POST:** the reply, after RES1 has resolved it.
2. **Tavern Helper's prompt pass:** tavern regexes, SillyTavern's `{{…}}` macros and Tavern Helper's own. SillyTavern's when Tavern Helper isn't there.
3. **The `{{mvuhelper::…}}` macros,** see below.

**Inside PRE and POST entries, `getvar` needs the full path:**

```ejs
<%= getvar("stat_data.Cast") %>   // correct in PRE/POST entries
<%= getvar("Cast") %>             // empty, there is no top-level variable named Cast
```

An entry with no `<%` in it skips the EJS pass. A broken template logs the error, and the call gets the raw text instead.

## The user message

**PRE gets your last line,** exactly as the narrator will read it: after prompt regexes, and on a swipe, the line the swipe answers.

**POST gets the finished reply,** with every patch block taken out: the narrator's `<UpdateVariable>`, any `<POSTUpdateVariable>`, and a bare `<JSONPatch>`. The stat box comes out too. A call that keeps records must not read back numbers it's about to record, and must never copy a patch that already landed.

**The input filter regex narrows it further.** It runs on what's left. With a capture group, the call reads group 1, otherwise the whole match. A regex that doesn't compile sends the full text, with a warning.

## OOC commands

`[ooc: …]` or `(ooc: …)` in your message, `ooc` in any case, is an order every model sees. Whatever it says.

PRE reads your line, so it already has them. A call whose input leaves them out gets them word for word, in an `<ooc_commands>` block after its rules. That's every POST call, since POST reads the reply, plus any PRE call whose input filter cut them.

An opening bracket that's never closed is no command, and the console says so.

## The macros: handing a call more

These go in a call's entries, written like any SillyTavern macro:

| Macro | You get |
| --- | --- |
| `{{mvuhelper::history}}` | the last narrator reply |
| `{{mvuhelper::history::N}}` | the last N replies, oldest first, each headed `--- reply -k ---`. Capped at 20 |
| `{{mvuhelper::userLine}}` | your last message. In POST, that's the line the reply answered |
| `{{mvuhelper::callOutput::<name>}}` | what another call answered this turn. POST entries only |
| `{{mvuhelper::task::<id>}}` | a routed task's instruction. MVU Helper writes this one, you never do |

Every one of them comes with the patch blocks taken out. A call gets story text, not patch data.

**A macro that can't resolve becomes empty.** The first turn has no history, a call can time out, a name can be wrong. The call still runs, and the console says why. So write your prompt so empty is fine: "if no history is given, treat this as the opening beat".

**`callOutput` only works in POST.** PRE calls run at the same time, so one can't read another's answer. By the time POST runs, every PRE call is done. In a PRE entry it resolves empty, with a warning.

**Don't use `{{lastCharMessage}}` or `{{lastUserMessage}}` in a call's entries.** They look the same, and they aren't. On a swipe, they give you the reply you threw away, and they give you the raw text, not what the narrator actually read. MVU Helper warns once per session when it finds them.

**Macros only read.** None of them writes a variable. To change state, a call answers with a patch block, see [PRE](pre.md) and [POST](post.md).

## Owned root: a call that remembers

Some PRE calls run a little simulation: a town's background life, a rival's plans, the weather. Each turn, they need to know what they decided last turn.

Give that call an **owned root**, like `/TownSim`, and MVU Helper adds that part of `stat_data` to the call's user message, every turn, as it stood before your line. The call reads its own last decision without you writing any EJS.

```
[PRE2] World_Simulation

You track the town's background life, the events the player hasn't seen.

WHAT JUST HAPPENED:
{{mvuhelper::history::2}}

Advance the background world one beat, and react to what happened above.
Emit a <JSONPatch> over /TownSim only.
```

Here's the difference between the 2 sources:

- **`history::N`** is what the story did. Prose exists nowhere else.
- **the owned root** is what this call decided. It survives a reload, follows a swipe correctly, and is checked by your schema.

Most simulations want both.

The owned root is a convenience, not a switch. It doesn't decide whether the call can write, and it doesn't limit where. Seed it in `[InitVar]`, and in your Zod schema if you have one, or the call runs without it and warns.

## Checking your work

Turn on these debug domains in MVU Helper's Main tab:

- **Pipeline** logs one line per call with what each macro gave: `[PRE2] macros: history::2=1840ch userLine=64ch`. `∅` means empty.
- **Small-LLM** dumps each call's finished system block, user message and answer. That's literally what the model saw.

[Back to How Extra LLM Calls work](technical.md) · [Back to index](../../README.md)
