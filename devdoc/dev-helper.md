# mvu-helper — Developer Guide

> **Audience:** card authors building an MVU game card on top of `mvu-helper`, and extension authors using its
> runtime API. Nothing here is specific to one game: swap the example names for your own.
>
> **What mvu-helper is:** an extension around [MVU](https://github.com/MagicalAstrogy/MagVarUpdate) that runs the
> turn around your card's narrator. It hosts the card's game engine in a sandboxed Worker and calls it every
> reply; it runs cheap PRE and POST LLM calls and puts their results where they belong; it installs the card's
> artifacts (GameLogic, StatusMenu and event packs, and plugins); and it draws images with consistent character
> appearance. Your card owns its state schema, its prompt windows and its engine's rules.
>
> **Tabs:** Main, Image Generation, Roster, Extra LLM Calls; LogicEngine, GameLogic Packs, StatusMenu Packs, Event
> Packs; and Development, for artifact developers.
>
> **Each artifact has its own doc:** the game engine and its pack — `gamelogic-pack-format.md` (worked example:
> MvuGameMaker `Schoolv4/doc/GameLogicEngine_Guide.md`); event packs — `event-pack-format.md` and
> `event-pack-engine.md`; the status menu — `statusmenu-pack-format.md`; plugins — `gamelogic-plugin-guide.md`; the
> side panel — `side-panel-format.md`; the stat box — `statbox-guide.md`; call-input macros —
> `call-input-macros.md`; what pack code can reach — `security-hardening.md`; editing a finished reply —
> `editing-a-finished-reply.md`.

---

## 1. The turn pipeline and its seams

### 1.1 One reply

```
preAssemblyPatch → PRE calls → preVerdictPatch → pickSameRoundEvent → narrate → RES1 → POST calls → RES2
```

| Stage | Kind | Job | Owned by |
| --- | --- | --- | --- |
| **preAssemblyPatch** | engine code | the engine's deterministic writes before the prompt is built | the card's engine (optional hook) |
| **PRE** | cheap LLM | classify the situation before the reply; inject a verdict for the narrator and/or write `stat_data` (§1.7) | mvu-helper runs the calls; the card writes their prompts |
| **preVerdictPatch** | engine code | the engine's writes on this turn's PRE verdict, before the prompt is built | the card's engine (optional hook) |
| **pickSameRoundEvent** | engine code | pick an event to play in this reply | the card's engine (optional hook) |
| **EJS** | template code | render a bounded read-side view of `stat_data` for each model | ST-Prompt-Template + mvu-helper |
| **narrate** | expensive LLM | the reply: prose, plus `/Intent` reports in `<UpdateVariable>` | ST core (the card's main prompt) |
| **RES1** | engine code | settle the narrator's reports into `stat_data` | the card's engine (`resolveTurn`) |
| **POST** | cheap LLM | read the finished prose and record what it shows | mvu-helper runs the calls; the card writes their prompts |
| **RES2** | engine code | settle POST's records in the same reply | the card's engine (`resolvePostRelay`, optional) |

When each engine hook runs, what it receives and what it returns: `gamelogic-pack-format.md` §4.2.

**The one rule that decides where a mechanic lives:** *table / lookup / clamp / formula / dice-with-a-rule* →
**code** (EJS or the engine); *subjective / linguistic* (judge tone, classify an action, write voice) → an **LLM**
(PRE / narrate / POST). The narrator reports in words on `/Intent` channels, and the engine turns the words into
numbers. That keeps the code stages pure and unit-testable, and lets one genre-blind extension drive many genres.

### 1.2 The EJS views

**EJS = the read-side view.** A bounded `<CURRENT_VARIABLE_DATA>` block rendered *purely from `stat_data`*. It
renders **once per model:**

| View | Feeds | State it reads | Rendered by |
| --- | --- | --- | --- |
| **EJS1** | PRE | the base floor: the last reply with state before the player's line | **mvu-helper** |
| **EJS2** | narrate | the main generation's context | **ST-Prompt-Template** (the card's Window-A entry) |
| **EJS3** | POST | the reply after narrate (and after RES1, on a card whose engine resolves turns) | **mvu-helper** |

> **How mvu-helper renders EJS1 and EJS3:** PRE and POST calls go through `ConnectionManagerRequestService`, a
> path that fires none of the events ST-Prompt-Template hooks, so mvu-helper renders those blocks itself. First
> EJS, pinned to the floor the call reads (`getvar` is bound to it). Then TavernHelper's prompt pass: tavern
> regexes, ST `{{…}}` macros and TavernHelper's macro-likes (SillyTavern's `substituteParams` when TavernHelper is
> absent). Last, the `{{mvuhelper::…}}` call-input macros (`call-input-macros.md`).

### 1.3 What each stage writes, and who reads it

**PRE and POST land their output in completely different places.**

| Stage | Writes its output to | Persisted? | Read by |
| --- | --- | --- | --- |
| **PRE** (prose half) | prepended onto the **last user message of the *prompt-building copy*** (`coreChat`) | **No** — discarded after the prompt is built | the **narrator**, this reply only |
| **PRE** (`<JSONPatch>` half) | the **user floor's** `stat_data` (§1.7) | **yes** — real MVU state, written to disk | **Window-A / EJS2** at assembly, then **RES1** after narrate |
| **POST** (output) | `globalThis.mvuHelper.lastPost` `[{name,label,output}]` | until the next turn | the **llm-task router** / your code, via the `mvuhelper:post-done` event |
| **POST** (patch blocks) | the reply, as `<POSTUpdateVariable>` — the player's receipt — and MVU state, through MVU's own parse | yes | **RES2**, when the engine exports `resolvePostRelay`; otherwise the next reply's RES1 |

> **Term — `coreChat` is the throwaway PROMPT copy, NOT the reply.** It is the chat **array ST clones for this one
> generation** and hands to the interceptor (`await interceptor(chat, …)` — that `chat` param is `coreChat`). ST
> builds it as a per-message shallow clone (`.map(m => ({...m}))`), so each message in it is a **different object**
> from the live saved `chat`. Editing it shapes the prompt the narrator reads, and is discarded the instant the
> prompt is assembled.

**The prose half does NOT write into the persistent `message.mes`.** It is injected onto the last **user turn of
`coreChat`** — so the narrator reads it as part of the user's turn, but it is never saved to disk, never shown in
the chat UI, never in swipes. `prependToMessage(coreChat[idx], block)` edits that object in place, and the object is
already ST's copy, so the change is confined to the prompt and dies with it. PRE feeds the narrator without
polluting the chat log.

**The `<JSONPatch>` half is a real, persisted `stat_data` write** — a different mechanism, not a variant of the
one above. It goes to the user floor's variables, outlives the prompt, and reaches RES1 by state inheritance rather
than through any prompt at all (§1.7). The two halves are independent and either can be present without the other.

**Where the injected PRE PROSE block is — and isn't — visible** (the patch half is state, so none of this applies to
it):

| Location | Visible? |
| --- | --- |
| the assembled prompt the narrator reads | **yes** — this is the delivery |
| a prompt inspector; the `[small-llm] [PRE]` line `injected onto user message #N` | **yes** |
| the chat UI (the user bubble) | no |
| the saved `msg.mes`, disk, swipes | no |
| the narrator's reply text | no (it reads it, doesn't echo it) |

One-line model: **PRE's prose writes to what the model READS; PRE's patch writes to what the STATE keeps.**

**POST's output.** A POST call runs only when the lorebook routes at least one entry to it (§2.4). Its output,
after the call's output check (§2.2), is pushed to `globalThis.mvuHelper.lastPost`, and the `mvuhelper:post-done`
event (`POST_DONE_EVENT`) is emitted with the message id. Whether POST also writes state is decided by the output,
not a setting: a POST call whose output carries a non-empty `<UpdateVariable>` patch is written into the reply and
applied (§1.6). A POST call that returns only text writes nothing.

**A reply with no POST call** (none configured, none routed, Extra LLM Calls off) still ends the same way: the
post-reply phase writes RES1's `<RES_Variable>` into the reply, sets `lastPost` to `[]` and emits
`mvuhelper:post-done`, which runs the plugins' `resolveRelay` once that reply's own parse is done.

### 1.4 The hand-off channels (the seams)

| Seam (from → to) | Channel | When |
| --- | --- | --- |
| EJS1 → PRE · EJS3 → POST | mvu-helper renders the call's block | at that call's assembly |
| EJS2 → narrate | ST-Prompt-Template renders into the assembled prompt | same reply |
| PRE → narrate | `coreChat` inject — `prependToMessage` edits the prompt copy's last user message | same reply |
| PRE → Window-A · PRE → RES1 | `stat_data` — the patch persists on the user floor, and MVU seeds the reply floor from it (§1.7) | same reply |
| narrate → POST | the reply's prose with every patch block (`<UpdateVariable>`, `<POSTUpdateVariable>`, a bare `<JSONPatch>`) and the stat box stripped, then narrowed by the call's input regex | same reply |
| narrate → RES1 | `/Intent/*` in the reply: MVU applies it and fires its update event, and mvu-helper calls the engine's `resolveTurn` | same reply |
| POST → RES2 | POST's patch blocks: applying them fires the update event again, and mvu-helper calls `resolvePostRelay` | same reply |
| RES1 → POST | on a card whose engine resolves turns, POST waits for RES1's signal (`mvu_helper_res_staged`, with a 4-second backstop) before it renders | same reply |
| every reply edit → the chat | the reply redraw writes the reply once, when the post-reply phase ends and the edits still being made have landed: the stat box built when MVU reads the reply's state, RES1's text and box, the image pass, POST's receipt, RES2's text, the box refreshed from the final state (`editing-a-finished-reply.md`), and other extensions' edits through its last call (`reply-redraw-api.md`); a picture still drawing at the deadline writes on its own | end of the same reply |
| RES1 · RES2 → EJS (next reply) | `stat_data` — the resolved state | next reply |

Non-obvious points behind these:

- **Why PRE has BOTH channels, and how to pick:** the prose half rides `coreChat` because a verdict the narrator only
  needs to READ has no business in `stat_data`. The patch half writes state because Window-A renders at assembly —
  *after* the PRE pass — so a pre-turn write surfaces THIS reply, not the next one. Choose by lifetime: needed for
  this one prompt → prose; needed by EJS, by the engine, or by a later turn → patch.
- **Why POST is fire-and-forget and timeout-bounded:** returning POST's promise would hold ST's awaited event chain
  on POST's model before MVU's own listener could parse the reply. Every call is bounded by the per-card **Call
  timeout**, so one stalled call can't freeze the turn.
- **Why POST waits for RES1:** so EJS3 renders this reply's resolved state. On a card with no engine nothing
  resolves, and POST does not wait.

### 1.5 The `stat_data.` prefix (EJS1 / EJS3)

⚠ Inside an **EJS1 or EJS3** block (the PRE/POST blocks mvu-helper renders), `getvar` reads the floor's message
variables, where MVU keeps its state under `stat_data` — so write the full path:

```ejs
<%= getvar("stat_data.Cast") %>   // ✅ correct in EJS1/EJS3
<%= getvar("Cast") %>             // ❌ empty — there is no top-level variable named Cast
```

### 1.6 How a POST call writes state (and reaches RES2)

> Writing your **own** code that edits a finished reply — `msg.mes`, `msg.swipes`, `msg.extra` or the
> `.mes_text` DOM — instead of letting mvu-helper write for you? Read
> [`devdoc/editing-a-finished-reply.md`](editing-a-finished-reply.md) first. A DOM rebuild that skips
> `MESSAGE_UPDATED` silently destroys the status-menu iframe until the chat is reloaded.

There is **no GUI switch** for this. A POST call writes state when its **output carries an `<UpdateVariable>` block
with a non-empty patch** — so you control it entirely from the call's lorebook prompt.

**The recipe:**

1. **Make the model emit an `<UpdateVariable>` wrapper** containing an inner `<JSONPatch>` (or `<json_patch>`).
   The **inner** tag is what MVU keys on. Shape the model must produce:

   ```xml
   <UpdateVariable>
     <JSONPatch>
       [ { "op": "add", "path": "/World/ImportantEvents/-", "value": "…" } ]
     </JSONPatch>
   </UpdateVariable>
   ```

2. **mvu-helper does the rest:**
   - renames the wrapper to `<POSTUpdateVariable>`, so it can be told apart from the narrator's own block (the
     inner `<JSONPatch>` is untouched), and writes it into the reply — after the narrator's first
     `</UpdateVariable>`, else just before `<StatusPlaceHolderImpl/>`, else at the end. That text is the player's
     receipt;
   - applies **only the POST block** through MVU's own parse and saves the result — on every card, whether or not
     anything resolves it. The parse fires MVU's update event, so in the same reply the game engine's
     `resolvePostRelay` (when it exports one) and each installed plugin's `resolveRelay` run on it; with no
     relay hook, the next reply's RES1 sees POST's changes. A reply whose POST calls write no block still runs the
     plugins' `resolveRelay`, once, after the reply (§1.3).

**The non-negotiable gotchas:**

- **The `<UpdateVariable>` wrapper is required.** Patch ops outside a wrapper are reported as lost and **not
  applied**. Prose with no patch structure is warned every turn, unless the call is an llm-task target (§6.3).
- **No page code in a block.** A block carrying `html>`, `<head>`, `<body` or `<%` is neither written nor applied,
  and the call's warning names the token: the reply is page text, which TavernHelper renders and
  ST-Prompt-Template runs (`security-hardening.md` §6).
- **Ops must be idempotent** (`replace` / direct sets, not blind `+=` accumulators). Emit a record on an `/Intent`
  channel and let the engine turn it into the real delta, or emit a direct `replace`.
- **Only the block is applied, never the whole reply:** applying the reply would re-apply the narrator's ops. MVU
  does not re-parse an edited message, and its direct setters write a value without firing the update event, so this
  parse is the one path that both applies the ops and lets the engine resolve them.
- **Hide POST's blocks from the narrator's prompt** with a prompt-only regex on `<POSTUpdateVariable>`: a narrator
  that sees them copies them into its own reply, and MVU applies a `<JSONPatch>` wherever it sits.

**If you only want the text** (image harvest, your own consumer): make the call an llm-task target and read its
output (§6.3). No patch block, nothing written.

### 1.7 How a PRE call writes `stat_data` — the sim rail (and why no RES runs at PRE time)

The mirror of §1.6. A POST call reaches state through MVU's parse of its block; a **PRE** call reaches state
directly, *before* the narrator runs. Same trigger shape as POST: **no GUI switch — the output decides.**

**A PRE call becomes a "sim" by emitting a `<JSONPatch>` block** (a bare JSON array of ops counts too). The patch may
write any path the card's Zod schema validates.

⚠ **There is no per-call state feed.** A sim reads its own earlier state the way every call reads state: EJS in its own
entries (`<%- getvar('stat_data.<path>') %>`), pinned to the base floor (§1.2), so a regenerate never evolves from its
own previous attempt. The retired `ownedRoot` field fed one subtree in and shortened the inject lines; a card that
still carries it is told so in the console on import, and a re-import deletes it from the profile (§5.2).

**What the runtime does with the output**, in order:

1. **Splits** the raw output into the `<JSONPatch>` block(s) and the prose remainder — *before* running the call's
   output-check regex. The two halves are validated by different things, so a stray preamble or `<think>` block can
   cost you the prose without costing you the state, and vice versa.
2. **Validates strictly, per block and per op.** One malformed block drops that block alone; one bad-verb op drops
   that op alone. Every refusal is warned by name.
3. **Applies at PRE time** onto the **last USER floor** through MVU's parse. On a swipe it also writes the **cache
   floor** (the latest AI floor), whose variables clone was taken before PRE ran — without that second write the
   injected lines and the Window-A view contradict each other on that one path.
4. **Injects prose RENDERED FROM THE OPS** (`path > value` lines, always the FULL dotted path — the path is the line's
   only label, and the narrator's rules name state by it), never the raw ops. Two reasons: an echoed
   `<JSONPatch>` would be re-applied by MVU's own parse of the reply, and machine syntax in a narrative prompt
   degrades the model — worst on the small ones.

**How it reaches the narrator and RES1.** Not through any prompt. The patch persists on the user floor; MVU seeds the
reply floor from it; **Window-A / EJS2 renders the new value at assembly**, and RES1 sees it after narrate by the
same inheritance. An `/Intent/*` write from PRE therefore resolves at RES1 — normally, once, in the same turn.

**No RES runs at PRE time, deliberately.** MVU's parse fires its update event, which the turn runner treats as "a
turn finished — resolve it" whenever the parse started from one of the two newest stored states. (A parse that started
anywhere else is no turn and is skipped — MVU's floor replay after a delete fires one per re-read message;
`turn-runner-core.js` `endedEventDisposition`.) The sim apply starts from the user floor, which passes that check, so
it wraps its own parse in `withLiveResolveSuppressed()` and the runner drops events arriving inside that window
(`src/features/logic-engine/live-resolve-gate.js`). Without the gate, an `/Intent`-rooted PRE write would be resolved
mid-turn against the **last AI floor**: the stat swing applies, and the intent is CLEARED before the narrator ever
renders it.

> **Consequence for card design:** RES1 runs after narrate and RES2 after POST. The PRE apply is a **write**, not a
> resolve. Anything PRE writes that needs derivation waits for RES1 — so freeze the inputs that derivation needs IN
> the record, because the state PRE measured against has moved by the time RES1 reads it.

**Guards you get for free, and their log lines.** The apply is fenced against the seconds the call takes: it drops
with a named reason if the user stopped the generation, if a newer generation started (stale epoch), if the user
floor is gone, or if the turn advanced. On each (floor, swipe) it records every path a PRE write touched and the
value that path held before PRE's first write there, and keeps that record on the message itself
(`extra.mvuhelper_pre_undo`), so a page reload or a chat switch does not lose it. A new generation re-applying puts
back exactly those paths, so a regenerate never evolves from its own previous attempt, while an edit the player made
anywhere else on the floor survives. After the write, each op is probed by VALUE against the persisted result — a card Zod schema that silently
strips an unenumerated path is announced (`op(s) did NOT take`) instead of failing quietly. All of this is
`[SIM]`-tagged in the console.

**The engine has three hooks on this rail:** `preAssemblyPatch` writes before the PRE calls run, through the same
fence, snapshot and value probe a sim patch gets; `preVerdictPatch` writes after them through the same apply, and is
handed their outputs; `pickSameRoundEvent` also runs after them and picks an event to play in this reply. All three
are described in `gamelogic-pack-format.md` §4.2.

**`continue`, `quiet` and `impersonate` are not turns of the story, and nothing on this rail runs for them** — no
engine patch, no PRE call, no apply. One definition (`isStoryTurnGenerationType`, logic-engine) decides that for the
PRE pass and for the dice dealer alike, so a Continue keeps both the dice its prose already spent and the verdict
already in state. The prose half is not re-injected on a Continue either: the verdict it carried is in state, and
Window-A renders it.

**Design rule:** when PRE decides something, PRE writes it. Asking the narrator to re-emit a PRE verdict puts a model
between a decision and its record.

### 1.8 clear data sync state

When new initvar data is already synced, and you want to sync it again, do the following in browser

const ctx = SillyTavern.getContext();
delete ctx.chatMetadata.mvuHelper.forceFromInitVarVer;
await ctx.saveMetadata();
ctx.chatMetadata.mvuHelper   // shows { dataSyncVer: "0.2.0" }


---

## 2. Extra LLM Calls tab — the PRE/POST relay

This tab defines the cheap side-calls. **Per card** (stored in the active character's profile): the page header names
the card, and its pill reads **Calls on** or **Calls off** from the master switch. With no chat open the pill hides,
every card greys out and the page says to open one: there is no card to save to. A call sends the lorebook entries
routed to it (plus any shared-group blocks) to a connection profile, and either injects the result before the reply
(PRE) or captures it after (POST).

### 2.1 Calls card

| Field | Stored | Default | Meaning |
| --- | --- | --- | --- |
| **Enable Extra LLM Calls** | `extraLlmCalls.enabled` | on | Master switch. Off = no PRE or POST call runs, and llm-task targets on PRE/POST calls drop out of the routing dropdowns. The engine's `preAssemblyPatch` still runs. |
| **Run calls in parallel** | `extraLlmCalls.parallel` | on | On = all calls of a phase run concurrently, **except** that calls sharing one connection profile still run one after another — they share a single endpoint, and a local one-slot server chokes if they all fire at once. Off = strictly sequential. |
| **Call timeout (s)** | `extraLlmCalls.timeoutSec` | 60 | Max seconds to wait for each PRE/POST call. A stalled call is given up — the turn's warning names it as timed out (§2.4) — and the others proceed: one hung request can't freeze the reply (PRE) or the record write (POST). It also sets the post-reply phase's clock: each POST call in the longest chain gets one Call timeout of the phase's time, a phase still running halfway through a slot raises a "POST slow" toast, and at the end of the last slot the reply's held edits are written without POST. Clamped 5–600. |

### 2.2 Call list card

One record card per call. **Add call** asks for the name and the phase before it adds anything: an unnamed call is
routed no entries and would quietly do nothing. A card's header says whether its call runs — the call's own switch,
its phase as a pill, and a warning pill for what keeps it from running: **No name**, or **No connection** while the
call is on. A call switched off on purpose shows no warning. The pills come from `callRunBlocker`
(`extra-llm-calls-core.js`), the same rule `enabledCalls` applies at run time.

| Field | Key | Meaning |
| --- | --- | --- |
| switch (header) | `enabled` | Enable/disable this single call without deleting it. |
| ▶ (header) | — | Run this call now against the last user message (or a sample) and surface the result via toast + the `smallllm` log domain. |
| 🗑 (header) | — | Delete the call, after a confirm that says what is lost and how a card's call comes back. |
| **Name** | `name` | The call's name: it routes the lorebook entries carrying `[name]` (§2.4) — the hint under the field shows that tag as you type — and names the call in groups. The call logs under its own tag, `[small-llm] [<name>]` (`PRE#n` when unnamed); whole-phase lines are tagged `[PRE]` / `[POST]`. |
| **Phase** | `phase` | **PRE** (before reply, over the last user message, injected into the prompt) or **POST** (after reply, over the AI's prose). Default `pre`. |
| **Connection** | `profileId` | The **connection profile** (the cheap model) this call runs against. Local per user — it is *not* carried in the card config (see §5). |
| **Max tokens** | `maxTokens` | Optional per-call max output tokens. Blank = the profile's preset. |
| **Temperature** | `temperature` | Optional per-call temperature. Blank = the profile's preset. |
| **Input filter** | `inputRegex` | Optional: trims what the call *reads* from the source text. Capture group 1 if present, else the whole match. Example: `<gametxt>([\s\S]*?)</gametxt>` sends only the tagged slice. For POST, every patch block and the stat box are already stripped before this runs. |
| **Output check** | `outputRegex` | Optional: what a valid PROSE output looks like. Only the prose half is checked — `<JSONPatch>` / `<UpdateVariable>` blocks are split out first and always survive. Prose that does not match is dropped (degraded-turn warning + toast) instead of flowing downstream. |

### 2.3 Shared groups card (token-saving)

Shared content (a roster index, the schema syntax) should live **once** in a group, not be copied into every call.

- A group is `{ tag, members:[callName…] }`. Its `[tag]` lorebook entries are prepended to every member call's block.
- **Add group** adds an empty group card: type its **Tag** (the header shows it, and **No tag** while it is blank — an
  untagged group routes nothing) and tick its **Members**, one checkbox per named call. The 🗑 in its header deletes
  it, after a confirm.
- A call can be in more than one group. All its group blocks are concatenated ahead of its own `[callName]` block.

**School v4 example:** a group `llmshare` with members `{PRE, POST}` carries the roster + schema once; `[PRE]` entries
carry the classify rules, `[POST]` entries the record rules, and prose/voice stays untagged (narrator-only). Rule-heavy
files move to the cheap model at full size instead of bloating the narrator prompt.

### 2.4 How routing resolves (for reference)

`collectLorebookBlock(callName)` gathers every lorebook entry — enabled or not, so a disabled data-carrier routes too
— that carries `[callName]`, or the tag of a group the call belongs to, anywhere in its comment or its keys
(case-insensitive). Each group's entries come first, in group order, then the call's own; within each block the entries
are sorted by their `order` (lorebook order breaks ties), and the blocks are joined into one system block. A call
that no entry routes to is skipped, not sent. The call's prompt is that block, rendered as §1.2 describes, plus the
input-filtered source text. A call that needs state reads it with EJS in its own entries. The player's
out-of-character commands — `[ooc: …]` or `(ooc: …)` in the message the turn answers, `ooc` in any case — are admin
orders every model sees, whatever they say: a call whose input leaves one out (every POST call, which reads the reply,
and any call whose input filter cut it) gets them word for word in an `<ooc_commands>` block after its rules. An opening
bracket never closed is no command, and the console says so. There is no separate "prompt box" per call — **the
lorebook is the prompt**, tagged by call name.

An entry's own `enabled` is SillyTavern's switch only — whether the narrator's prompt can include it — so a PRE/POST
entry is often disabled on purpose. Whether a routed entry reaches a model is decided by Extra LLM Calls alone: the
master switch and each call's own switch. On chat load, and after any change to the calls, the groups or that
switch, a call that will not run while lorebook entries carry its tag is named in the console with those entries
(a group tag counts only when none of its calls runs). A call that is on but has no connection profile also raises
a toast: it was meant to run.

A call that leaves its pass nothing usable is named in one `[PRE]` or `[POST]` warning and one toast per turn, each
with its cause: it **failed or timed out**, it **answered with no text** (with what the provider's response held: the
finish reason, a refusal, how many output tokens it spent and how many were reasoning), or it **left nothing usable after
the checks** (the output check, or on PRE a patch refused or not applied). Two answers are not failures. A call that
carries only routed tasks — every entry routed to it is a task's `mvu-llm-task:` entry, as on a card with no logic
engine — has no duty of its own, so its answer with no text goes to those tasks, which judge it (the looks task warns
for each newcomer it asked to register and got no look for, §3.1); the pass logs it on the `pipeline` domain. And a PRE
answer that is an empty patch alone is the contract's quiet turn.

---

## 3. Roster tab — the character registry

This tab owns **character appearance**: a store of each character's visual DNA so generated art stays consistent, and
the machinery to build that store automatically from the story ("harvest"). **All per card**: with no chat open both
cards grey out and the page says to open one.

### 3.1 Registration card

Storing looks is independent of the Image tab: harvest runs with images off, and images run with harvest off.

| Field | Key | Default | Meaning |
| --- | --- | --- | --- |
| **Appearance route** | `route` | `harvest` | **Predefined only** (`predefined`): the card supplies the characters (its `[InitVar]`, §3.3); anyone else is described by the story for that reply's pictures only, and nothing is stored. **Predefined + auto-harvest new** (`harvest`): the story describes each NEW character once and the entry is stored; a character already on file is never asked for again. |
| **Harvest via** | `charimgVia` | `''` (Off) | *Auto-harvest only.* Which LLM call writes a new character's look to store it. Looks are stored when the route is auto-harvest AND a target is picked. **Off** = nothing stored. **narrate** = the main reply describes everyone in it who is not ON FILE, once; the instruction is injected into the narrator's prompt directly, with no lorebook entry. **A POST call name** = a focused pass, routed by a data-carrier entry `[<call>] mvu-llm-task:<id>` that mvu-helper writes, re-points on a switch and deletes on Off; its text is built per turn from the reply's cast against the registry: registered characters get one line each and write nothing, newcomers get the full rules, a turn with nobody new gets the short rules. A picture of anyone with no stored look waits for the POST call's registration, even when the reply describes them: the stored look is the one kept, and the reply's own description is used only when nothing was stored. A drawn name that no cast record registers, and that has no appearance on file, is warned under `[character-roster] [harvest]`, and so is a newcomer the POST call was asked to register and left without one: the call answers nothing when nobody needs a record (§2.4), so this warning is how a skipped newcomer shows. A leftover `<charImage>` tag is ignored with one warning per chat. **narrate** is not offered while a POST call writes the pictures (**Pictures written by**, §4.1): it reads the reply's `<pic>` tags as the reply arrives, before that call has written any. (Powered by the llm-task router — see §6.3.) |
| **Roster collection** | `charCollection` | `''` (auto) | *MVU cards only.* The `stat_data` object holding the character roster (e.g. `Partner`, `Familiar`, `Cast`). A leading `stat_data.` is optional. Blank = auto-detect by the present-flag record shape. When found, the on-screen characters are fed to the model so `char=` uses their exact keys. Non-MVU cards ignore this. |
| **Present flag** | `presenceField` | `''` (`Is_present`) | *MVU cards only.* The per-character boolean field marking on-screen presence. Blank = the default `Is_present`; set it (e.g. `inHere`, or `是否在场`) if your card names it differently. Drives **both** auto-detection of the roster collection **and** the on-screen present-check. |

> **The reply cast.** Whenever images are on (Insert Type anything but Disable) or looks are stored, the narrator ends
> every reply with one cast record per named character present (`<cast name="…">`, one line each, no closing tag,
> pattern `<cast\b[^>\n]*>`), and its prompt lists who is **ON FILE**: the registered characters with a stored look
> whom the story has named anywhere in the chat (a name in Latin letters counts only as a whole word), whom the game
> state marks present, or on one of whose names a lorebook entry in the prompt is keyed (one of the entry's keys equal
> to their key or an alias, so the reply that brings them in already lists them), each with their `outfit=` choices —
> their outfits on file ("no outfit on file" when they have none). Characters with the same set of outfits share one line, so a cast in one set of school outfits is one line.
> A character named in the last 10 messages or present is also offered `same-as-last-picture` while the store below
> holds what their last picture showed, on a line of its own after the groups with what it draws: an outfit's name,
> or a one-off's clothes. The main character gets the same line for `mainchar=`, `- {{user}} (mainchar=): town-casual`,
> whenever the store holds what he wore, and every outfit on his entry is ON FILE on a line of his own after the groups
> (`- {{user}} (mainchar=): school-uniform, …, town-casual`); he still never takes a record.
> A character ON FILE is written by name only; anyone else who needs a look gets `body=` and `clothes=` on their
> record, once — the first `body=` tag says what they are (man, woman, elf woman …). Every `<pic>` slot names what that
> person wears in the shot: a choice on their ON FILE line, `newclothes` or `undressed`. The prompt says the list is all
> that is on file: anyone it leaves out — a character the story names for the first time with no lorebook entry in the
> prompt keyed on their name, or one with no look stored — is `newclothes` or `undressed`. A character's first clothes are always stored: someone with no clothes on file
> (a newcomer, or an entry holding only their `[Body]`) keeps the clothes their record gives them, under its outfit
> name when a place or role fixes them (`cafe-waitress`), else as their `[Clothes]`, listed as `default`. After that a
> one-off outfit is `outfit="newclothes"` with `clothes=` on the record, and is never saved to the registry: mvu-helper
> keeps it in the card's state, `stat_data.$mvuhelper.worn_outfit`, keyed by registry entry and stamped with the message of their last
> picture, and offers it back as `same-as-last-picture`, so a swipe, a regenerate, a deleted reply or a new chat is
> always right. Clothes the registry keeps from a reply's record (first clothes, a new saved outfit) are the clothes
> the reply's picture drew them in, when it drew them in a one-off, whichever call wrote the record; they are held in
> the store by the outfit's name, never as a copy of the text, so editing that outfit in the Roster reaches the next
> picture; a one-off stays text there, and **Wearing now** (§3.2) edits either. A slot that names nothing they have (no `outfit=`, an outfit they lack) is drawn in what the store
> holds for them, else with no clothes, and the console names the slip. At the end of every reply the streetcleaner
> drops an entry no picture has drawn for more than 100 replies, so the store never keeps everyone ever drawn in the
> chat. A card with a Zod schema declares `$mvuhelper` open (`z.record(z.string(), z.any()).prefault({})`): a closed
> declaration strips every part it does not name, nothing anyone wore is offered back, and the console says so once per
> chat (a schema that strips only `last_picture_message` loses every entry to the streetcleaner, and the console names
> the field). A card with no Zod schema needs nothing: mvu-helper writes its root directly, and MVU's own derived
> schema judges only `<UpdateVariable>` commands.

> **Present flag ↔ roster interplay:** a character *record* is detected as "an object carrying the present-flag field".
> So the roster collection is discovered by shape (the top-level `stat_data` object whose children carry that boolean),
> and the on-screen set is those whose flag unwraps to `true`. MVU stores a field as a `[value,"Label"]` tuple;
> mvu-helper reads index `[0]`. A card with native presence in `stat_data` needs **no** external presence extension —
> point Present flag at its field name.

### 3.2 Character registry card

The characters on file in this chat and the tools to manage them. The page header's pill counts them (**On file:
N**); with no chat open the pill hides and the card waits, greyed, for one.

- **Refresh** (the ↻ in the card's header): re-read the list.
- **The list** (ten rows a page, pager **x / y**): one row per character — its **name**, its outfits as pills, its
  aliases on a line below (**Also known as**), then its buttons: **story clothes updates**, **Edit**, **Reset to the
  card's look** (only on a character the card seeds and this chat changed), **Rename**, **Merge**, then
  **Re-harvest** and **Delete** in red.
  - **Story clothes updates** (🔒 off / 👕 on): off by default — the story never replaces the character's
    registered clothes. On — the story may replace them (the body is never changed).
  - **Edit** (✎): opens the character in a dialog (wide on a desktop), its **Outfit** section: **Body**, **Bust** (a number, §4.5),
    **Aliases** (one name per line), one **Outfit name** and clothes box per outfit (`default` is the `[Clothes]` one),
    each with **×** to remove it, and **Add outfit** for a new one. The (?) beside a name explains the naming:
    `place-outfit`, where it is worn and then what it is (`school-uniform`, `beach-swimsuit`), because the story picks
    an outfit by its name. An outfit the card seeds comes back from the card on the next load or Re-import when
    removed; the dialog names those. Then the story-updates switch, and **Wearing now**: what the character's last
    picture shows and their next picture starts from — one of the outfits above (the list follows **Add outfit**, **×**
    and a renamed outfit), **One-off clothes** (their box shows while that is picked) or **Nothing recorded** — with
    the message that picture is in. Changing it rewrites every saved state from that picture on, so ↻ on that picture
    draws the change at once; older pictures keep what they showed. **Save** names any problem (a bust that is not a
    number, an outfit name with a space, an outfit named but given no clothes, one-off clothes left blank, an outfit the
    record no longer has) and opens the dialog again; **Cancel** leaves the record as it was.
  - **Reset to the card's look** (🕘): puts the card's own record for this character back, from its `[InitVar]`,
    over what this chat changed (it confirms). From then on the character follows the card again (§3.3).
  - **Rename**: the appearance is right but the key is wrong. Keeps the look; the old key still resolves. Refused for a
    character the card seeds — the seeded key would come back on the next load; add the spelling to its aliases.
  - **Merge**: the same character registered twice under different spellings. Opens a dropdown of the other entries
    under its row; **Merge** (it confirms) discards this entry's appearance and makes its key an alias of the one
    you pick. Merging a seeded character away is refused, as Rename is; merging into one is not.
  - **Re-harvest** (↻): **deletes** the entry (it confirms). With auto-harvest the story re-describes the character
    on their next appearance (this is how you refresh a bad capture). On Predefined only it leaves them
    unregistered until re-authored. A character the card seeds comes back from the card instead.
  - **Delete** (🗑): remove the entry (it confirms). A character the card seeds comes back on the next load or
    Re-import from card.

Every edit here is written into each state a new generation can start from (the two newest messages that hold one),
and **Wearing now** also into every state since the character's last picture, so a regenerate or a swipe of the newest
reply keeps it; an edit is refused while a reply is being generated.

### 3.3 Where the registry lives, and how a card seeds it

The registry is part of the chat's state, `stat_data.$mvuhelper.character_registry`: MVU stores it with every message
and swipe, so a swipe, a regenerate, a deleted reply and a reload keep the right one, and deleting the card or its
lorebook loses nothing. Each chat has its own. One record per character, keyed by name:

```json
"$mvuhelper": {
  "character_registry": {
    "Airi": {
      "body": "identity danbooru tags — face, hair colour+length+style, eye colour, skin, body/figure. NO clothing.",
      "bust": 1.2,
      "aliases": ["Kuraha", "倉葉アイリ"],
      "clothes": { "default": "every garment worn", "school-gym": "the gym outfit" },
      "allow_update": false
    }
  }
}
```

`clothes` maps an outfit name to its garments (`default` is the one drawn when no outfit is named; named outfits show
as badges); `bust` is the bust LoRA's number (§4.5); `aliases` are other spellings that resolve to this record;
`allow_update` is the story-updates switch. A record with no body and no clothes is a name-only entry, minted when a
`<pic>` draws someone the registry has never heard of, so Merge can make it an alias. The registry never enters the
prompt: TavernHelper's variable macros skip every key starting with `$`, and a look is read **only at draw time**, for
the character being drawn. Inside mvu-helper each record is handled as the entry text it always was (`[Body]`,
`[Clothes]`, `[Clothes:<outfit>]`, `[Bust]`, `[Alias]`, `[AllowUpdate]`), so the harvest and the draw decide exactly as
they did.

**Seeding.** A card ships its characters in its `[InitVar]`, under `$mvuhelper.character_registry`; a new chat starts
from them. On every chat load, after a pack install, and on **Re-import from card**, mvu-helper re-applies the card's
`[InitVar]` to each state a new generation can start from, so a regenerate right after keeps it: a character or outfit
the card adds appears, and a value the card changed reaches every chat that never changed it (the re-seed). A value
the chat changed — a Roster-tab edit, clothes the story replaced — is kept, unless the card's GameLogic Pack forces it
(`state.force` or `state.forceFromInitVar`, with a `state.version` bump, `gamelogic-pack-format.md` §8).

**A card's schema** declares `$mvuhelper` open: `$mvuhelper: z.record(z.string(), z.any()).prefault({})`. The blank
GameLogic Pack and Plugin from the Development tab ship it.

---

## 4. Image Generation tab — drawing

This tab governs **whether pictures are on, who writes the reply's `<pic>` tags (the narrator, or a POST call that
reads the finished reply), and how a detected `<pic>` is drawn**, plus the
shared teaching contract. It is independent of the Roster tab: Image Insert Type owns the image instruction and the GPU;
the Roster tab owns whether looks are stored.

**Each drawn person's look** is, in order: their stored entry; else the look their cast record in the same reply gives
them; else nothing — they are drawn from the scene alone, and the console names them. A picture whose people need a
look from the reply waits for the finished reply instead of drawing mid-stream.

> **Scope note:** the Backend card's settings are **GLOBAL** (the same for every card: streaming, queue concurrency, the
> bust LoRA, resolution presets), and so is the `/sd` prefix LIST. Everything else on the tab is **PER-CARD**, and greys
> out while no chat is open. Marked below.

### 4.1 Rendering card

| Field | Key | Scope | Default | Meaning |
| --- | --- | --- | --- | --- |
| **Image insert type** | `insertType` | per-card | `disabled` | **Disable** (`disabled`): no image instruction, nothing drawn. **Tags only** (`tags`): the instruction is sent and the tags are logged and disposed of per Strip, with no GPU — the way to check what the picture writer writes. **Insert In Current Message** (`inline`), **Create New Message** (`new`), **Inline Replace Mode** (`replace`): sent and drawn. In Inline Replace Mode each image carries a ↻ that draws it again with every look as the Roster holds it now, and the clothes of each person it is the last picture of in its reply as that reply saved them, so a Roster edit or **Wearing now** (§3.2) shows at once; the console logs it as `regen [...] drawn=…`, the line a first draw logs as `gen [...]`. |
| **Pictures written by** | `picturesVia` | per-card | `narrate` | Who writes the reply's `<pic>` tags. **narrate (main reply)**: the narrator, while it writes the story — the picture rules open its prompt and `<picture_count>` ends it. **A POST call**: for a narrator model that skips the picture rule in a long prompt. The narrator then gets no picture rules and no past picture in its history; the call reads the finished reply, after its own input filter, with every line of text numbered `[n]` and `<picture_count>` after it, and writes each `<pic>` with `at="<n>"` (its contract is the card's template in the reader's words: `plans/executed/picture-writer-route.md` R2, D5). mvu-helper puts each tag on its own line under that line, adds the call's one-off clothes records after the narrator's records, and draws the tags as it draws a narrator's, in the turn's one write. A `<pic>` the narrator writes anyway is taken out of the reply, never drawn. No Off: Insert type = Disable turns pictures off. POST calls are not offered while **Harvest via** is narrate: registration on the narrator reads the pictures as the reply arrives, before the call writes them. A call that does not run (off, deleted, no connection profile, or Extra LLM Calls off) leaves the reply without a picture, with a warning each reply and one toast per chat. A POST call that does other work can carry it too: the call writes its `<pic>` tags beside its other output, and reads the reply numbered for all of it. `<picture_count>` comes after the reply because the card's own POST rules come after the picture rules in that call's system block, and a model that does only the duty it read last would otherwise write the card's output alone. The player's own choice for their models: a card never carries it. |
| **Strip `<pic>` tag** | `stripPicTag` | per-card | on | Take the `<pic>` tag out of the visible reply; the reply keeps it invisibly (inside the image, or as a trace where it stood), so the worn-outfit store and a regenerate still read every picture's tag, and the narrator sees its earlier tags — independent of drawing, so it also fires with Insert Type = Tags only (keeps galgame's parser from stalling on a lingering tag). Off = keep it visible in-chat for troubleshooting. Either way the prompt is logged to the console (imagegen debug domain). |

### 4.2 Prompt & size card

| Field | Key | Scope | Default | Meaning |
| --- | --- | --- | --- | --- |
| **/sd prompt prefix** (the list) | `sdPromptPrefixPresets` | global | one preset, "Default" | The NAMED prefix list — `[{ id, name, text }]`. Each `text` is prepended to **every** image before composition + character DNA (quality / LoRA-trigger / style tags), so you keep one preset per checkpoint or art style. Additive to SillyTavern's own SD prompt prefix. A comma or period closing the text is dropped, since the composition follows it after ", ". **New / Rename / Delete** edit the list; the textarea edits the picked preset's text. Deleting sweeps every profile that pointed at it → `''` (never a dangling id). |
| **/sd prompt prefix** (the pick) | `sdPromptPrefixPresetId` | per-card | `default` | Which preset THIS card draws with. `''` = the **— none —** row: no prefix at all. Per-card so an anime card and a realistic card each keep their own without re-picking on every switch. |
| **Max images per reply** | `maxImagesPerReply` | per-card | 1 | How many pictures one reply may carry. The picture writer is instructed (`<picture_count>`, the last thing it reads): every scene change (another place, a jump in time, someone new arriving) gets another `<pic>`, up to this number, and the reply's last scene always gets one. A new pose or more talk in the same scene adds nothing. Tags past the number are logged and not drawn. Galgame play typically 2–3. |
| **Max characters per image** | `maxCharactersPerImage` | per-card | 3 | The CEILING on how many people with a look one image holds, the main character included — never a quota; one person alone is a normal shot. Any whole number from 1, no limit in code: each look is copied whole into the prompt, so the image model's text budget is the real bound. The contract's `[CAST]` block is built from it. Each named person takes one slot — `char=`/`outfit=`, `char2=`/`outfit2=`, `char3=`/`outfit3=` … — and their look is opened by their name and wrapped in a tag of it (`<name> is: [<name>] … [/<name>]`; one person alone is `The person in the frame is <name>: [<name>] … [/<name>]`); the main character's look is `[main character] … [/main character]`, and the narrator calls him "the main character" in a composition. A period inside a stored look reads as a comma, so it never ends the look early. Where each one stands is the composition's to say. A plain concatenation of looks bleeds one person's traits onto another. Clothes everyone shares are stated once (`Both wear: …`). Over the ceiling the main character is dropped first, then the last slots, with a warning. Unnamed people are scenery and never count. |
| **Main character entry** | `maincharRegistryKey` | per-card | `''` | The Roster key of the entry holding the main character's look ({{user}}) — an ordinary registry record (body, clothes, outfits: same reader, same outfit rules). The narrator never names or registers the main character: `<reply_cast>` lists your persona name, this key and the entry's `[Alias]` names as names that take no cast record, and a record under one of them is ignored (the POST registration call is never asked about it, and the harvest stores nothing from it). Every `<pic>` carries `mainchar=`, written after `prompt=`: `default\|<outfit>\|undressed` whenever any part of {{user}} is in the frame, a pov shot aside — the image model draws a whole body for every body part it is shown, except {{user}}'s own hands in a pov shot, which the narrator writes as `pov hands` with what they do — and `not-in-picture` otherwise. An outfit appends the look as the closing sentence (`The main character in the frame is …`). `not-in-picture` or no `mainchar=` ⇒ not drawn: a tag with none is warned, a composition that names him anyway (the persona name, this key, `mainchar` or `{{user}}`) outside a pov shot is warned, and nothing is added. The card declares the key in its `[Initmvuhelper]` config. Blank ⇒ the main character is drawn from the scene alone; a key with no look behind it is warned. |
| **Image type** | `defaultImageType` | per-card | `landscape` | The aspect EVERY picture on this card is drawn at, regenerated ones included. The narrator does not choose: a `type=` on a `<pic>` is ignored, so every image (and every galgame backdrop) shares one shape. |

### 4.3 Scene gates card

Optional latches that gate token-heavy injections on `stat_data` booleans, so a turn that doesn't need them saves
tokens.

| Field | Key | Default | Meaning |
| --- | --- | --- | --- |
| **Intimacy latch path** | `intimacyLatchPath` | *(blank)* | Dot-path (under `stat_data`) of a boolean that flips on during an explicit/H scene. The explicit-scene composition guidance (`<explicit_rules>`) is injected **unless** this reads an explicit `false` — so a SFW turn drops it. Tuple auto-unwrapped. See the states below. |
| **Always inject H guidance** | `hBlockAlwaysOn` | off | Escape hatch: always inject `<explicit_rules>`, ignore the latch entirely. |

**The path has no built-in default.** mvu-helper does not know any card's state tree, so the shipped default is blank
and the CARD declares the real path in its `[Initmvuhelper]` config block. (School v4 declares
`PendingState.IntimacyActive` — a labelled example, not a value to copy: your card's tree is your own.)

**The states a path can be in:**

| state | intimacy latch |
| --- | --- |
| **blank** — the card declares nothing | `<explicit_rules>` injected (the non-MVU default) |
| **configured, no state loaded yet** — no chat, or MVU has not started | withheld |
| **resolves** | injected unless it reads an explicit `false` |
| **configured but does NOT resolve** in the loaded state | **withheld (fail-closed)** + a console warning naming the path |

> ⚠ **A path that is not in the card's state stops its feature.** The card declares the path in `[Initmvuhelper]`, and a
> card upgrade that changes it reaches your setup on the next chat load (§5.2). A path typed here, or a card that renamed
> a state root while its `[Initmvuhelper]` kept the old path, points at nothing: the read emits an ungated `[imagegen]`
> warning naming the failing path. Fix the path here, or in the card.
>
> The latch fails **closed** on purpose: an author who configured a gate asked for gating, and dropping the gate while
> keeping the injection is the one reading nobody asked for. Fail-closed is visible (an intimate beat renders without
> the explicit floor); fail-open is invisible (SFW turns silently carry explicit instructions).

### 4.4 Teaching contract card

The instruction text sent to the narrator to make it emit image tags. **Per card, and card-owned** (§5.2): a card can
carry its own in `[Initmvuhelper]`, and a card upgrade refreshes it. Blank means the built-in one, so a card that carries
none always sends the contract this mvu-helper ships; the panel shows the built-in text, and text identical to it is
stored blank. It is sent while the card's Image Insert Type is anything but Disable. The `[CAST]` rules (`{{castRules}}`), the outfit
rules (`<outfit_rules>`), the camera (`<camera>`), during an explicit scene `<explicit_rules>`, and the picture count
(`<picture_count>`) ship from code and reach every install, whatever its saved template says. The fixed rules go out as ONE
system message at the very top of the prompt, in that order, so a provider's prompt cache reuses them on every reply;
`<explicit_rules>` comes last because it comes and goes with an explicit scene. `<scene_roster>`, which changes with who
is on screen, is placed by **Position** and **Depth**. `<picture_count>` goes at the end of the prompt, after
`<scene_roster>`, as a system message: how many `<pic>` tags this reply carries, where they go and when to write them
(with the sentence each one shows), what the extension does with them, and that no other reply format removes them. It
sits where a preset's own reply template sits, because a narrator follows what it read last, and it is sent exactly
when the contract is — a card can read its presence as "image generation is on".

| Field | Key | Meaning |
| --- | --- | --- |
| **Prompt template** | `promptTemplate` | The contract text. Blank = the built-in one; **Reset to default** returns to it. |
| **Regex** | `promptRegex` | The regex that detects `<pic>` tags in the reply. Blank = the built-in one; **Reset to default** returns to it. A `<pic>` inside the narrator's thinking (`<think>`, `<thinking>`, `<thinking_*>`) is never drawn, counted or swept: a draft is not the reply's. |
| **Position** | `promptPosition` | The role `<scene_roster>` is injected as: `@D ⚙️` (deep system, the default), `@D 👤` (deep user), `@D 🤖` (deep assistant). The fixed rules are always a system message at the top, and `<picture_count>` a system message at the end. |
| **Depth** | `promptDepth` | Where `<scene_roster>` is injected, counted back from the end (0 = the end, the default; 0–100). |

### 4.5 Backend card

The card carries a Global chip: these settings are the same for every card. The bust variable and the resolution
presets sit in two rows inside it that open on a click.

| Field | Key | Scope | Default | Meaning |
| --- | --- | --- | --- | --- |
| **Streaming pre-generation** | `streamingPregen` | global | on | Start generating the moment a complete tag appears mid-stream, instead of waiting for the full reply. |
| **Queue concurrency** | `queueConcurrency` | global | 1 | How many `/sd` calls run at once (1–4). A property of your GPU — ComfyUI stability usually wants 1. |
| **Send bust multiplier** | `bustStrength.enabled` | global | **on** | Writes the picture's `[Bust]` value into a ST chat variable (`bustStrength.variableName`, default `bust_strength`) via `/setvar` immediately before each `/sd` call, for a workflow that loads a bust LoRA. **The switch owns SillyTavern's ComfyUI custom placeholder** for it (`extension_settings.sd.comfy_placeholders`, entry `{ find: <variable>, replace: '{{getvar::<variable>}}' }`, `imagegen/comfy-placeholder-seed.js`): seeded on load while it is on, when it is switched on, and when the variable is renamed (the old name's entry goes); switching it off removes an exact copy only, so a user's own entry under that find with another replace is never touched (it is named once per session). The workflow itself must carry `"%<variable>%"` on a **typed FLOAT input** (`LoraLoaderModelOnly.strength_model`); a raw rgthree Power-Lora-Loader widget takes no typed input, so ComfyUI never coerces the string and the LoRA silently no-ops with only a logged `ERROR`. The LoRA MULTIPLIES the cup size the text already asserts. Requires **Queue concurrency 1** — the variable is global and parallel jobs would race; the panel warns if you enable it above 1. |
| **Bust variable name** | `bustStrength.variableName` | global | `bust_strength` | The chat variable the multiplier is written to, in the **Breast slider LoRA config** row. Renaming it moves the placeholder with it. |
| **Bust default / shared value** | `bustStrength.defaultValue` · `bustStrength.sharedValue` | global | 1 · 1.5 | Only people whose entry declares `[Bust]` count. Nobody ⇒ `defaultValue`; one ⇒ their own value; two or more ⇒ `sharedValue`: the LoRA is one model-wide strength, so they share one value while their individual sizes still differ in the prompt text. A look from a reply's cast record declares none. |
| **Resolution presets** | `resolutionPresets` | global | see below | The image type → width × height map, in the **Resolution presets** row. Defaults: portrait 768×1152, landscape 1152×768, plus closeup / scene / square. A property of your VRAM. |

---

## 5. Main tab — general + card config

### 5.1 General and Debug cards

| Field | Key | Scope | Meaning |
| --- | --- | --- | --- |
| **Language** | `language` | global | UI language (English / 简体中文). |
| **Console verbosity** (the Debug card's header) | `debug_verbosity` | global | Console verbosity: **Disabled** (errors/warnings only), **Lifecycle** (+ major state changes), **Verbose**, **Trace** (progressively finer). |
| **Debug switches** | `debug_domain.*` | global | Per-subsystem deep-dives, one switch each, independent of the level: **Small-LLM** (each PRE/POST call's system block, user text, response), **Pipeline** (the turn's stage lines — `[small-llm] [PRE]`, `[<call>]`, `[SIM]`, `[POST]`, `[logic-engine] [RES]`, `[RES2]` — and the engine's own pipeline lines), **Image gen**, **Roster**. |

A card's entries and scripts, and an engine in the Worker, read these three by name through
`MvuHelper.settings` (`debug.verbosity`, `debug.<switch>`, `language`), and an entry can turn a debug switch on
or off; the table of names is in `gamelogic-plugin-guide.md` §4, "Settings".

### 5.2 Card config (the carry mechanism)

A card can ship its **mvu-helper setup** inside the card so anyone who loads it gets it automatically. The registry of
what travels is `features/card-config/card-config-sections.js`, and every field is one of three kinds:

| Kind | First load of the card | A card upgrade, or Re-import from card | Fields |
| --- | --- | --- | --- |
| **card-owned** | from the card | **refreshed from the card** | each Extra-LLM call's phase, max tokens, temperature and input/output regex, and each group's members; `imagegen` intimacyLatchPath, maincharRegistryKey, promptTemplate, promptRegex, promptPosition, promptDepth; the stat box (`statBox` — `devdoc/statbox-guide.md`) |
| **card-seeded** (the player's preferences) | from the card | **kept** | Extra-LLM `enabled`, `parallel`, `timeoutSec` and each call's `enabled`; `imagegen` insertType, defaultImageType, maxImagesPerReply, maxCharactersPerImage, stripPicTag, hBlockAlwaysOn, charimgVia; `roster` route, charCollection, presenceField; `logicEngine` enabled |
| **never travels** | — | — | each call's connection; the /sd prompt-prefix pick; every global setting |

- **Export config → card**: writes the setup into a `[Initmvuhelper]` lorebook entry (mirrors MVU's `[InitVar]`).
- **Every chat load** compares the card's entry with the config this card's profile last imported (a fingerprint of the
  parsed config, so the entry's comments and whitespace do not count). A card opened for the first time is installed. A
  changed entry — a card or pack upgrade rewrote it — is re-imported, the same merge as the button. An unchanged entry
  is left alone, so a card-owned field edited in the panel stands until the card's config next changes. A card-owned
  field the card carried before and has dropped goes back to its built-in default; one it never carried stays yours.
- **Re-import from card**: the same re-import, on demand — calls and groups the card has and the profile lacks are added
  (a call you deleted comes back), card-owned fields are refreshed, and every connection assignment and preference is
  kept. It also deletes profile keys mvu-helper no longer reads. First it re-seeds this chat from the card's `[InitVar]`,
  as a chat load does (§3.3): what the card added appears, a value the chat never changed takes the card's newer one, and
  what the chat changed is kept; a toast counts what it added and updated, or says the lorebook could not be read yet.
- **Reset from card** (the danger zone at the bottom of the tab): forgets this card's stored setup and installs the
  card's again, preferences included. **Reset every card** clears the stored setup of every card; each re-imports its
  own the next time it is opened. Both confirm. With no chat open, the Card config card and Reset from card grey out and
  the page says to open one; Reset every card still works.

> **What is NOT carried:** the small-LLM **connection profile** stays local (each user assigns their own model per call
> in Extra LLM Calls). The card carries *which calls exist and what they read*, not *which server runs them*.
>
> **No per-call `preset`, by design.** ST bundles a preset *into* a connection profile, so "a different preset" is "a
> different profile" — make a second one in ST's Connection Manager and select it. Honouring an override here would mean
> mvu-helper writing to ST's shared profile object mid-request; **mvu-helper is read-only on ST state**. Only knobs that
> ride the request itself are per-call: `maxTokens`, `temperature`.

---

## 6. Runtime API and conventions (for card / extension code)

### 6.1 `globalThis.MvuHelper` and `globalThis.mvuHelper`

`MvuHelper` is the page API (`src/index.js` publishes it), on every card mvu-helper runs on, with an engine or
without. It is frozen: an entry cannot add to it or replace a piece of it.

| Member | What |
| --- | --- |
| `engineInfo()` | The running engine's `{ name, type, version, packId, exposes }`; every field `null` with no engine (`gamelogic-plugin-guide.md` §8.1). |
| `exposes()` | The active pack's interface map (`gamelogic-plugin-guide.md` §8.2). |
| `rollPool(count, hash, poolName, sides)` | mvu-helper's dealer: dice the prompt shows, which the engine reads later as `ctx.dicePools` (`gamelogic-plugin-guide.md` §4, "Dice: your own pool"). |
| `packInfo()` | `async`. What is installed, in the library and on this card, for all four artifact kinds, with the `disagreements` between the two. |
| `log` | mvu-helper's logger, as the `[card]` source (`gamelogic-plugin-guide.md` §4, "Logging"). |
| `settings` | mvu-helper's settings by name: `get(name)`, `names()`, and `set(name, value)` for a debug switch (`gamelogic-plugin-guide.md` §4, "Settings"). |
| `statusMenuFrameSource({ rowName, mid, statData })` | `async`. The contained menu frame's `{ sandbox, srcdoc }`, for an extension that mounts the menu in a frame of its own (`statusmenu-pack/statusmenu-frame.js`). |

`mvuHelper`, with a small `m`, holds this turn's call outputs and the debug handles:

| Member | What |
| --- | --- |
| `lastPre` | `[{name,label,output}]` — the current turn's PRE call outputs (populated by the interceptor before the reply). |
| `lastPost` | `[{name,label,output}]` — the current turn's POST call outputs. |
| `runLlmCall(call, input)` | Run one call object ad hoc (used by the Test button). An answer with no text warns what the provider's response held. |
| `collectLorebookBlock(callName)` | Gather the lorebook block routed to a call (§2.4). |
| `runPostPass()` | Manually trigger the POST pass (unguarded — bypasses the greeting/import fences). |
| `mvuHelperInterceptor(chat,…)` | The registered generate-interceptor (the PRE pass). |

### 6.2 Events

- **`mvuhelper:pre-done`** (`PRE_DONE_EVENT`) — emitted by the interceptor after `lastPre` is populated, with the
  user-message index (no reply exists yet). Subscribe to consume PRE output before the reply.
- **`mvuhelper:post-done`** (`POST_DONE_EVENT`) — emitted once per generated reply after `lastPost` is populated
  (`[]` when no POST call ran), with the message id, whether a POST block is about to be parsed, and whether any
  POST call ran. Subscribe to consume POST output (this is how image-harvest captures a routed POST call).

### 6.3 The llm-task router — the raw-output developer API

This is the public API for **"run my instruction on a user-chosen call and hand me its output to massage."** The
"Harvest via" and "Pictures written by" dropdowns are its clients; the router itself is feature-agnostic
(`llm-task-router/llm-task-router.js`, `llm-task-router/llm-task-router-core.js`). Register a task and you get, for
free: a routing dropdown (Off / narrate / a call), the instruction injected into the chosen call, and the chosen call's
output delivered back to you.

**Register a task** (from a feature folder):

```js
import { registerLlmTask, applyTaskRouting, renderLlmTaskSelect } from '../llm-task-router/index.js';

registerLlmTask({
  id: 'my-feature',              // unique task id
  label: 'My feature',           // shown in logs
  tag: 'myTag',                  // the <tag> name your instruction tells the model to emit
  allow: ['narrate', 'post'],    // which phases the dropdown offers (see the matrix below)
  instruction: '…' ,             // string | ({ phase, messageId }) => string | Promise<string> — the contract text for the chosen call;
                                 // SillyTavern macros in it ({{user}}, {{char}} …) are expanded on every target
  getTarget: () => prof.myVia,   // return the STORED preference ('' | 'narrate' | a call name)
  setTarget: (v) => { prof.myVia = v; saveSettingsDebounced(); },
  isActive: () => prof.enabled,  // your own gate; false = dormant (no inject, no capture, preference kept)
  // optional:
  getActiveTarget: () => '…',    // where it runs this turn when that is not the stored preference
  offersOff: false,              // your feature has its own off switch: the dropdown lists no Off
  offers: (target) => true,      // which targets the dropdown lists now (a rule about which of your settings go
                                 // together); the stored value is always listed, and routing is never affected
  shapeInput: ({ text, phase, messageId, callName }) => text,   // what the PRE/POST call carrying the task reads,
                                 // applied right after that call's own input filter, for that call only
  onOutput: (raw, meta) => {
    // raw  = the chosen call's OUTPUT — no extraction, no rename, no <UpdateVariable> stripping
    // meta = { phase: 'narrate'|'pre'|'post', target, messageId }
    // massage `raw` however you like (parse your <tag>, store, etc.)
  },
});
```

**Helper calls:**

- `applyTaskRouting('my-feature')` — reconcile the routing for the current target (call on target-change and on card
  load). Calls for one task run one at a time, so the target read by the last call is the one that stays. **narrate** → programmatic injection at `CHAT_COMPLETION_PROMPT_READY` (no WI entry, so no WORLDINFO churn);
  **a call** → a disabled data-carrier entry commented `[callName] mvu-llm-task:<id>` that the relay pulls into that
  call's block; **Off** → delete the entry. The data-carrier holds the token `{{mvuhelper::task::<id>}}`, never the
  text: the PRE/POST pass resolves every routed task's `instruction({ phase, messageId })` before its calls run, so a
  task words its instruction per turn (`messageId` = the reply for POST, the user message for PRE, `null` for narrate).
- `isTaskTargetAvailable('my-feature')` — whether the task's target answers now (narrate, or a call that is enabled, has
  a connection profile, and Extra LLM Calls is on); false for Off. Use it to say why your output never comes.
- `renderLlmTaskSelect('my-feature', '#your_select')` — populate a static `<select>` in place with the valid targets.

**`onOutput` gets the model's output, unmassaged.** The router is an output *pipe*: the `<POSTUpdateVariable>` rename
and the write into the reply are POST-relay transforms that never touch what `onOutput` (or `lastPost`) sees. A PRE
call's output and the narrator's reply arrive exactly as written. A POST call's arrives after its output check (§2.2):
prose that fails the call's output regex is not delivered, its patch blocks still are. Parsing and massaging are
entirely your job.

**The two halves of a task — where the instruction goes IN, and where the output comes OUT.** Both are symmetric across
all three phases; set `allow` to any subset of `['pre','narrate','post']`.

**(A) Where your `instruction` is INJECTED** (so the chosen model reads it and emits your `<tag>`):

| Target | The instruction lands in… | Delivered by | Reaches the model as |
| --- | --- | --- | --- |
| **narrate** | the narrator's own main prompt | a programmatic system message pushed at `CHAT_COMPLETION_PROMPT_READY` (no lorebook entry — no WORLDINFO churn) | part of the narrate prompt |
| **PRE call** | that **PRE call's** system block | a disabled lorebook entry commented `[callName] mvu-llm-task:<id>`, which `collectLorebookBlock(callName)` pulls into the call | part of that PRE call's system prompt |
| **POST call** | that **POST call's** system block | the same `[callName] mvu-llm-task:<id>` data-carrier entry | part of that POST call's system prompt |

`applyTaskRouting(id)` is what writes/repoints/deletes that entry when the target changes. You never build the entry
yourself — set the target (dropdown or `setTarget`) and call `applyTaskRouting`.

**(B) Where the OUTPUT comes FROM** (so you can massage it):

| Target | `raw` (arg 1 of `onOutput`) is… | Buffered in | Fires on | `meta` |
| --- | --- | --- | --- | --- |
| **narrate** | the reply text `msg.mes` | — (no buffer; it *is* the message) | `MESSAGE_RECEIVED` | `{ phase:'narrate', target, messageId }` |
| **PRE call** | that PRE call's output, as written | `globalThis.mvuHelper.lastPre` | `PRE_DONE_EVENT` (before the reply) | `{ phase:'pre', target, messageId }` — `messageId` = the user-message index PRE read (no reply exists yet) |
| **POST call** | that POST call's output, after its output check | `globalThis.mvuHelper.lastPost` | `POST_DONE_EVENT` (after the reply) | `{ phase:'post', target, messageId }` |

**PRE capture fires before the narrator reply**, so a PRE-target task can pre-process the situation and act on it that
same turn; POST capture fires after, over the finished prose. Tasks get their outputs in the order they registered: the
picture task registers before the look task, so registration reads the pictures it placed.

**Three ways to read a PRE/POST call's output** (all return the same text):

| Method | Use when |
| --- | --- |
| `registerLlmTask({ onOutput })` | you also want the Off/narrate/PRE/POST dropdown + auto-routing (recommended) |
| subscribe the phase's event (`PRE_DONE_EVENT` / `POST_DONE_EVENT`), then read the buffer | you just want the text, no routing UI |
| read the buffer in your own handler | ad-hoc / debugging |

Both buffers are `[{ name, label, output }]` — find your call by `name`. PRE lives in `globalThis.mvuHelper.lastPre`,
POST in `globalThis.mvuHelper.lastPost`. (narrate has no buffer — its output is the reply `msg.mes`; read it via
`onOutput` or a `MESSAGE_RECEIVED` subscription.)

### 6.4 Lorebook comment conventions

| Comment tag | Meaning |
| --- | --- |
| `[<callName>]` | An Extra-LLM call's prompt block. Matched anywhere in the comment or the keys. |
| `[<groupTag>]` | A shared-group block, read by member calls. Matched the same way. |
| `[Initmvuhelper]` | The carried card config (Export/Re-import). |
| `[<callName>] mvu-llm-task:<id>` | An llm-task routing data-carrier, for a PRE or POST target. |

The entries the installers write (`[MVU_LogicEngine]`, `[GameLogicPack:<id>] …`, `[MVU_Event_Pack] …` and the
others) are described in each pack's format doc.

---

## 7. Building a card on mvu-helper

1. **The game** — a GameLogic Pack (`gamelogic-pack-format.md`): the engine that resolves each reply, the card's
   prompt windows as entries, its Zod schema and its `[InitVar]` seed. Start from **Add New Blank Packs** and develop
   with the **Artifact dev loop**, both on the Development tab.
2. **The narrator's view** — a Window-A entry (EJS2) that renders the state the narrator needs. The narrator reports
   what its prose did on `/Intent` channels; the engine resolves them (§1.1).
3. **PRE and POST calls** — `[PRE]` and `[POST]` entries carry each call's rules, and shared material goes in a group
   (§2). Add the calls in Extra LLM Calls, pointed at a cheap model. A PRE call's prose reaches the narrator, and its
   `<JSONPatch>` writes state before the narrator runs (§1.7). A POST call's patch blocks record what the prose showed
   (§1.6).
4. **Drawing (optional)** — pick **Harvest via**, set **Image Insert Type**, and author or harvest the appearance
   entries (§3, §4).
5. **Ship** — **Export config → card**, so the mvu-helper setup travels with the card (§5.2); users assign their own
   connection profiles. **Export** the GameLogic Pack from the GameLogic Packs tab, and any StatusMenu Pack from the
   StatusMenu Packs tab.

Every stage is bounded by the **active scene** (the characters present and what this reply touched), never by the
accumulated save.
