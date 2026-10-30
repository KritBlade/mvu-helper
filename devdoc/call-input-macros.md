# Call-input macros — giving a PRE/POST call sight of the story

**Audience: card authors.** You write these in a lorebook entry. No JavaScript, no settings, no GUI.

A PRE or POST call normally sees only two things: its own routed lorebook entries, and one line of
user text — plus the player's `[ooc: …]` commands whenever that text leaves them out (dev-helper §2.4).
It cannot see the story. These macros are how you hand it more.

```
{{mvuhelper::history::2}}
```

Paste that into a `[PRE2]` entry and the call receives the last two narrator replies.

---

## The tokens

| Token | You get |
|---|---|
| `{{mvuhelper::history}}` | the last narrator reply |
| `{{mvuhelper::history::N}}` | the last N replies, oldest first, each headed `--- reply -k ---` (`-1` = most recent) |
| `{{mvuhelper::userLine}}` | the user's last message |
| `{{mvuhelper::callOutput::<name>}}` | what another call answered **this turn** — **`[POST]` entries only** |
| `{{mvuhelper::task::<id>}}` | a routed task's instruction for this call and this turn — mvu-helper writes this one into the task's routing entry; you never write it |

Everything is stripped of `<UpdateVariable>` blocks before you get it — you receive story text, not
patch data.

**Any token that cannot resolve becomes empty.** First turn with no history, a call that timed out,
a name that does not exist — all of them produce nothing and let the call run. Write your prompt so
empty is survivable ("if no history is given, treat this as the opening beat"). A console warning
names the reason, so check the console when a token comes back empty and you did not expect it.

## A worked example — a world simulator

Add a call named `PRE2` (Extra LLM Calls tab → **Add call** → name it, choose **PRE**), then write a
lorebook entry prefixed `[PRE2]`:

```
[PRE2] World_Simulation

You track the town's background life — events the player has not seen.

WHAT JUST HAPPENED:
{{mvuhelper::history::2}}

THE WORLD AS IT STANDS:
<%- JSON.stringify(getvar('stat_data.TownSim')) %>

Advance the background world one beat. React to what happened above.
Emit a <JSONPatch> over /TownSim only.
```

Two sources, two jobs, and the difference matters:

- **`history::N`** — what the **story** did. Prose exists nowhere else.
- **the state** (`getvar`) — what **this call itself** decided last time. It lives in `stat_data`, so
  it persists across reloads, follows swipes correctly, and is validated against your schema.

Most sims want both. Reading the world from state and the events from history is the normal shape.

## Which source do I use?

| I want… | Use |
|---|---|
| what **this call** decided, in earlier turns | **its state** — `getvar('stat_data.<the path it writes>')` |
| what **the story** did | **`{{mvuhelper::history::N}}`** |
| a **sim call's** result, from a `[POST]` entry | **the state it wrote** — `getvar`, not `callOutput` (see below) |
| a **non-sim** call's raw answer, this turn | **`{{mvuhelper::callOutput::<name>}}`** |

⚠ **`callOutput` on a sim call gives you the raw `<JSONPatch>` text**, not the world state — that is
the call's literal answer, before validation. By the time a `[POST]` entry renders, the patch has
already been applied, so read the state instead and get the real values.

## Rules worth knowing

**`callOutput` works in `[POST]` entries only.** PRE calls run at the same time as each other, so
one PRE call cannot read another's answer — there is no "before". POST runs after every PRE call has
finished, so there the answer is always there. In a PRE entry the token resolves empty and warns.

**Do not use `{{lastCharMessage}}` or `{{lastUserMessage}}` in a call entry.** They look equivalent
and are not: on a swipe they return the reply you *rejected*, and they return the raw message text
rather than the cleaned-up version the narrator actually read. Use `{{mvuhelper::history}}` and
`{{mvuhelper::userLine}}`. mvu-helper warns once per session if it finds them.

**Macros only read. They never write.** To change stored values, emit a `<JSONPatch>` — mvu-helper
does the writing, at the right moment, with its own safety checks. There is deliberately no macro that sets a variable: when a saved value turns out wrong, you
want exactly one place to look.

**History is capped at 20 replies.** More than that is a huge prompt for little gain.

## Checking your work

Turn on the `pipeline` debug domain and each call logs what it actually received:

```
[PRE2] macros: history::2=1840ch userLine=64ch
```

`∅` means the token resolved to nothing. That line is the fastest way to tell "my prompt is wrong"
from "the macro gave me nothing" — and it prints the empty case on purpose, because a token that
silently vanished looks exactly like one you never wrote.

The `smallllm` domain dumps the finished system block, after every macro is substituted — that is
literally what the model saw.
