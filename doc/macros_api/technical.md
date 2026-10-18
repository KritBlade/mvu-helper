# Every macro and API call

> This page applies to any card. ArtificKoi shows up as a real example, not as a rule.

This is the full list: every macro MVU Helper fills in, every function it puts on the page, every event it fires and every flag it publishes. Each one says where it works and what it gives back. Where another page explains it in depth, the link is right there.

## What's on this page

1. [Where each one works](#where-each-one-works) > the 4 places your code can run, and what reaches each.
2. [Macros](#macros) > `{{mvuhelper::…}}` in PRE and POST entries, PRE and POST reading each other, the engine's name, and the placeholders in MVU Helper's own settings.
3. [`MvuHelper`](#mvuhelper-on-the-page) > the page API: identity, dice, install report, logging.
4. [`LogicEngine`](#logicengine-your-engine-from-the-page) > your own engine's functions, called from EJS.
5. [`mvuHelper`](#mvuhelper-the-calls-answers) > this turn's PRE and POST answers, and the debug handles.
6. [Events](#events) > what MVU Helper fires on SillyTavern's `eventSource`.
7. [Flags](#flags-is-this-a-real-turn) > 2 globals that tell a real turn from a page-load render.
8. [Inside the engine sandbox](#inside-the-engine-sandbox) > what your GameLogic Engine, a plugin and an event pack can ask for.
9. [Inside the status menu frame](#inside-the-status-menu-frame) > what a builder menu can call.
10. [Entry names MVU Helper reads](#entry-names-mvu-helper-reads) > the lorebook comment tags.
11. [Writing](#writing) > how a change actually gets saved.

## Where each one works

Your code can run in 4 places, and each one gets a different set:

| Where | What it is | What reaches it |
| --- | --- | --- |
| **the page** | your entries' EJS, a Tavern Helper script, another extension | `MvuHelper`, `LogicEngine`, `mvuHelper`, the events, the flags, `{{mvuhelperEngineName}}` |
| **PRE and POST entries** | the entries routed to a call | all of the page, plus the `{{mvuhelper::…}}` macros |
| **the engine sandbox** | your GameLogic Engine, a plugin's engine, your menu engine | its own `MvuHelper`: identity, logging, the message list. Nothing on the page |
| **the status menu frame** | the menu the builder made | a small prelude, plus `MvuHelperFrame` |

The sandbox and the frame are locked on purpose. Code in there can't see the SillyTavern page at all, so the page API simply isn't there. Why it's that strict is in the Security point of the [README](../../README.md).

## Macros

### `{{mvuhelper::…}}`: handing a call the story

These work in **PRE and POST entries only**. A call has no chat history, so they're how it gets any.

| Macro | You get |
| --- | --- |
| `{{mvuhelper::history}}` | the last narrator reply |
| `{{mvuhelper::history::N}}` | the last N replies, oldest first, each headed `--- reply -k ---` (`-1` is the most recent). Capped at 20 |
| `{{mvuhelper::userLine}}` | the user's last message. In POST, that's the line the reply answered |
| `{{mvuhelper::callOutput::<name>}}` | what the call named `<name>` answered this turn. **POST entries only** |
| `{{mvuhelper::task::<id>}}` | a routed task's instruction. MVU Helper writes this one into the task's routing entry, you never do |

The token names don't care about case. `{{MvuHelper::History::2}}` works too.

Everything comes with its `<UpdateVariable>` blocks taken out. You get the story, not patch data.

**A macro that can't be filled in becomes empty, and the call still runs.** The first turn has no history. A call that timed out has no answer. A name that doesn't exist matches nothing. The console says why each time, so check it when a macro comes back empty and you didn't expect it.

**`callOutput` is POST only, because PRE calls run at the same time.** One PRE call can't read another's answer, there is no "before". POST runs after every PRE call is done, so there the answer is always there. In a PRE entry, it comes back empty with a warning.

**On a sim call, `callOutput` gives you its raw `<JSONPatch>`, not the world.** By the time a POST entry renders, that patch is already applied. So read the state with `getvar` instead, and you get the real values.

**Don't use `{{lastCharMessage}}` or `{{lastUserMessage}}` in a call's entries.** On a swipe, they give you the reply you just threw away, and they give you the raw text instead of what the narrator actually read. Use `{{mvuhelper::history}}` and `{{mvuhelper::userLine}}`. MVU Helper warns once per session when it finds them.

A worked example, a call that remembers, and which source to use when are on [What a call reads](../extra_llm_calls/prompts.md#the-macros-handing-a-call-more).

### PRE and POST reading each other

**In a POST call, the PRE that just ran.** POST runs after every PRE call of this turn is back, so the macro has it:

```
[POST] Story_Analysis

WHAT THE PRE CALL JUDGED THIS TURN:
{{mvuhelper::callOutput::PRE}}
```

`PRE` is the call's name, so use yours. When that PRE call wrote a `<JSONPatch>`, read the state instead, `<%- JSON.stringify(getvar('stat_data.TownSim')) %>`. That's the values after the patch, not the patch text.

**In a PRE call, last turn's POST.** There's no macro for this one, and that's on purpose. PRE runs BEFORE the reply, so this turn has no POST yet. And a POST call's answer isn't saved anywhere, only its `<UpdateVariable>` block is.

So POST writes what the next turn should know into the state:

```
[POST] Story_Notes

After the reply, write one short note for the next scene, as a patch:
<UpdateVariable>
<JSONPatch>
[ { "op": "replace", "path": "/World/LastNote", "value": "Mitsuki is still upset about the rooftop." } ]
</JSONPatch>
</UpdateVariable>
```

And PRE reads it back with EJS:

```
[PRE] Social_check_system

WHAT POST NOTED LAST TURN:
<%= getvar('stat_data.World.LastNote') %>
```

Seed `/World/LastNote` in `[InitVar]`, and in your Zod schema if you have one. A closed schema strips a path it doesn't list.

That's the better road anyway. A note in the state survives a reload, and on a swipe or a regenerate, PRE reads the note of the reply you're actually on. `mvuHelper.lastPost` lives only in memory, so a reload empties it, and after a swipe it can hold the POST of a reply you threw away.

### The real thing: ArtificKoi's initiative

ArtificKoi does both, every single turn.

Its classmates reach out to you on their own. A girl greets you in the hallway, invites you somewhere, or texts you from home. But not every reply. A girl who just reached out rests before she does it again: 3 days if she's outgoing, 5 in the middle, 7 if she's reserved.

That one rule needs PRE and POST to talk in both directions:

1. **PRE picks.** Its entry shows it who's allowed to reach out right now, worked out by the engine. PRE picks Mitsuki, `Mitsuki:T2`: she invites you somewhere.
2. **The narrator writes the reply.** Or it doesn't write her at all. An event can take the scene, or the narrator simply leaves her out.
3. **POST checks, and reads PRE from this turn.** Its entry has `{{mvuhelper::callOutput::PRE}}`, so it sees PRE's pick. It reads the finished reply and answers one question: did Mitsuki actually invite you? Only a yes is recorded, as `/Intent/initiative = "Mitsuki:T2"`.
4. **The engine stamps it.** `resolvePostRelay` writes the game time into `Classmate.Mitsuki.LastInitiative`. That's her rest clock.
5. **Next turn, PRE reads it, from the state.** Its entry asks the engine for the menu, and the engine reads `LastInitiative`. Mitsuki shows up as resting, so PRE can't pick her again until her rest is over.

The 2 lines that do it, shortened from ArtificKoi's entries:

```
[POST] Story_Analysis_Detail
...
{{mvuhelper::callOutput::PRE}}
```

```ejs
[PRE] Initiative_Menu
<% const sd = getvar('stat_data') || {}; %>
<%- await LogicEngine.initiativeMenu(sd) %>
```

**Why PRE's pick alone isn't enough.** PRE picks before the reply exists. If the pick started the clock, a girl the narrator never wrote would rest 5 days for nothing. Only POST has read the reply, so only POST can say it happened.

**Why POST only records, and the engine writes.** POST answers yes or no, and that's all. The game time, the rest days and the stamp are the engine's. A model is good at reading a page, not at doing dates.

**Why the state and not `lastPost`.** The stamp is saved with the reply that showed the invite. Swipe that reply, and the swipe you keep has its own state: if she didn't invite you on that one, she isn't resting. Reload the page, and the stamp is still there. `lastPost` would get both wrong. A reload forgets she reached out, and a swipe remembers an invite that's no longer on screen.

Relationship fallout, who's still with you when the reply ends, and a new classmate getting ready to join all travel the exact same road: POST records, the engine writes, the next PRE reads the state.

### `{{mvuhelperEngineName}}` and `{{mvuhelperEngineVersion}}`

These work anywhere SillyTavern fills in macros: the narrator's entries, PRE and POST entries, your preset.

| Macro | You get |
| --- | --- |
| `{{mvuhelperEngineName}}` | the running engine's `ENGINE_NAME`, like `School`. Empty on a card with no engine |
| `{{mvuhelperEngineVersion}}` | the running engine's `ENGINE_VERSION`. Empty on a card with no engine |

They're for plain text only. EJS runs before macros are filled in, so `<% if ('{{mvuhelperEngineName}}' === 'School') %>` is ALWAYS false: EJS sees the raw token. Branching code uses `MvuHelper.engineInfo()`. See [The ordering trap](../gamelogic_plugin/any_game.md#the-ordering-trap).

### Placeholders in MVU Helper's own settings

These aren't SillyTavern macros. MVU Helper fills them in itself, in one place each:

| Placeholder | Where | You get |
| --- | --- | --- |
| `{{maxImages}}` | the Image tab's contract template | the card's Max images per reply |
| `{{castRules}}` | the Image tab's contract template | the `[CAST]` block: how many people one picture may hold |
| `%bust_strength%` | your ComfyUI workflow | the `[Bust]` number of the person drawn. MVU Helper adds this placeholder to SillyTavern for you |

See [The contract and its 2 placeholders](../image_gen/prompt.md#the-contract-and-its-2-placeholders) and [The ComfyUI placeholder](../image_gen/drawing.md#the-comfyui-placeholder).

## `MvuHelper` on the page

`globalThis.MvuHelper` is the page API. It's on every card MVU Helper runs on, with a game or without. It's set the moment MVU Helper loads, it's never deleted, and it's frozen, so an entry can't add to it or replace a piece of it.

| Member | What it gives you |
| --- | --- |
| `engineInfo()` | `{ name, type, version, packId, exposes }` of the running game. Every field is `null` on a card with no engine |
| `exposes()` | the active pack's interface map, like `{ "cast@1": "Classmate" }` on ArtificKoi. `{}` when no pack is active |
| `rollPool(count, hash, poolName, sides)` | an array of dice, dealt in code. See below |
| `packInfo()` | `async`. Everything installed, in the library and on this card. See below |
| `log` | MVU Helper's logger, for your own scripts. See below |
| `statusMenuFrameSource({ rowName, mid, statData })` | `async`. For an extension that shows a status menu in its own frame. See below |

### `engineInfo()` and `exposes()`

The 2 questions a plugin made for any game asks first: which game is this, and where does it keep things.

```ejs
<%_ const _engine = (globalThis.MvuHelper && globalThis.MvuHelper.engineInfo()) || {}; _%>
<%_ if (_engine.name === 'School') { _%>
...only on ArtificKoi...
<%_ } _%>
```

Read only the interfaces your plugin declared in its `pack.json`, even though `exposes()` gives you the whole map. An interface you didn't declare gets no check at install. See [Running on any game](../gamelogic_plugin/any_game.md).

### `rollPool(count, hash, poolName, sides)`

MVU Helper's dealer. Your card's EJS deals the dice while the prompt is built, the narrator is shown them, and your engine gets the exact same dice later as `ctx.dice` and `ctx.dicePools`.

```ejs
<% const d = MvuHelper.rollPool(1, null, 'check', 20); %>
The D20 for this check is <%= d[0] %>.
```

- 1 to 20 dice, 2 to 1000 sides, 20 sides when you leave it out.
- Ask again with the same pool name and size, and you get the same dice for the rest of that generation.
- `hash` as `null` is a fresh crypto roll. A value seeds it: the same hash always gives the same dice.
- A plugin deals from a pool with its own name, like `'WEATHER'`. On ArtificKoi, a call with no pool name reads the game's own pool, so you'd get the same dice its checks use.

It's on `MvuHelper` and not on `LogicEngine` on purpose. `LogicEngine` is gone on a card with no engine, and for a moment during every engine reload. The dealer has to be there anyway. See [Dice](../gamelogic_engine/runtime.md#dice) and [Dice: your own pool](../gamelogic_plugin/entries.md#dice-your-own-pool).

### `packInfo()`

The one call that answers "what is actually installed?", across all 4 kinds: GameLogic Pack, GameLogic Plugin, StatusMenu Pack and Event Pack.

```js
const info = await MvuHelper.packInfo();
info.disagreements;   // read this first: empty means the card and the library agree
```

It returns `{ source, types, library, eventPackDetail, disagreements }`. `source` names the lorebook it read. `types.<kind>.installed` has the same shape for all 4 kinds.

I made it for a console, a bug report or another tool, anything outside the tabs. Reading the card's embedded lorebook by hand gives the wrong answer whenever a standalone world is bound, and this one call always reads the right one.

### `log`

Your own scripts can log through MVU Helper, the same way MVU Helper does:

```js
MvuHelper.log.child('EJS').warn('no Classmate on this card');
```

prints `[mvu-helper] [card] [EJS] no Classmate on this card`.

| Method | Prints |
| --- | --- |
| `error`, `warn` | always |
| `lifecycle`, `verbose`, `trace` | when the Debug settings on the Main tab say so |
| `domain(name, level, …)` | when that domain's toggle is on: `pipeline`, `imagegen`, `roster` or `smallllm` |
| `child(tag)` | a logger that adds `[tag]` to every line |

It's optional. `console` still works. See [Logging](../gamelogic_plugin/entries.md#logging).

### `statusMenuFrameSource({ rowName, mid, statData })`

For an extension that wants to show the card's status menu in a frame of its own. It returns `{ sandbox, srcdoc }`: you set both on your frame, and the menu runs in the same locked frame MVU Helper uses. `null` when the card has no such menu.

- `rowName` is the regex row's name, `StatusMenu` when you leave it out.
- `mid` and `statData` are the message and the state the menu starts with. After that, the owner of the frame pushes new state.

You never handle the menu's page yourself, and you never copy the lock. See [Where the menu runs](../statusmenu_engine/frame.md).

## `LogicEngine`: your engine from the page

`globalThis.LogicEngine` has one `async` function for every function your engine exports, plus `_version`.

```ejs
<% const lines = await LogicEngine.sweepCandidateLines(getvar("stat_data")); %>
```

That's ArtificKoi asking its engine which events could happen right now, so the entry only shows the narrator those.

- **Always `await` it.** Every call crosses into the sandbox and back.
- **Exports that aren't functions aren't there.**
- **It's missing on a card with no engine,** and for a moment during every engine reload. Missing is how you know there's no engine. So check before you call.

See [Your card's EJS can call the engine](../gamelogic_engine/runtime.md#your-cards-ejs-can-call-the-engine).

## `mvuHelper`: the calls' answers

`globalThis.mvuHelper`, with a small `m`, is a different global from `MvuHelper`. `MvuHelper` is the frozen API. `mvuHelper` holds this turn's call answers, and a few handles for testing.

| Member | What it is |
| --- | --- |
| `lastPre` | `[{ name, label, output }]`, this turn's PRE answers, filled before the reply |
| `lastPost` | `[{ name, label, output }]`, this turn's POST answers. `[]` when no POST call ran |
| `runLlmCall(call, input)` | runs one call right now. That's what the **Test** button uses |
| `collectLorebookBlock(name)` | the entries a call named `name` would get |
| `runPostPass()` | runs the POST pass by hand. For testing only: it skips the checks that keep POST off a greeting |
| `mvuHelperInterceptor` | the hook SillyTavern calls before every generation. Never call it yourself |

Find your call in `lastPre` or `lastPost` by its `name`. The answer is untouched: no renaming, no stripping. A POST call's answer arrives after its output check.

Read them after the matching event, not on a timer. See [The developer API](../extra_llm_calls/post.md#the-developer-api).

## Events

MVU Helper fires these on SillyTavern's `eventSource`:

```js
eventSource.on('mvuhelper:post-done', (messageId, postBlockComing, anyPostRan) => {
    const mine = (globalThis.mvuHelper.lastPost || []).find((c) => c.name === 'POST');
});
```

| Event | When | What the listener gets |
| --- | --- | --- |
| `mvuhelper:pre-done` | after every PRE call is back and `lastPre` is filled. No reply exists yet | your line's message index |
| `mvuhelper:post-done` | once per generated reply, after `lastPost` is filled. Fires even when no POST call ran | the reply's message id, whether a POST block is about to be parsed, whether any POST call ran |
| `mvu_helper_turn_phase` | when the first PRE or POST call starts, and when the last one ends | `{ busy, phase, open }`. `phase` is `pre` or `post`, `open` is how many are still running |
| `mvu_helper_state_saved` | every time MVU Helper saves a message's state itself | `{ mid, writer }`. `writer` names who saved it, like `pre-sim` or `event-pack` |
| `mvu_helper_res_staged` | when the engine has resolved a turn and staged the result | `{ mid, swipe, epoch, willSave }` |

**`mvu_helper_turn_phase` is how you know a turn is still working.** PRE and POST calls don't go through SillyTavern's normal generation, so SillyTavern's own events say nothing about them. Without this event, a busy indicator would show the tab as idle while POST is still running. My galgame-companion extension uses it for exactly that.

**Don't count on `busy: false` always arriving.** Every call closes its phase, even one that throws. But a connection that hangs forever never closes. So a UI that waits on it needs its own time limit, and should say when it hit it.

**`mvu_helper_state_saved` exists because MVU's own save says nothing.** When MVU Helper writes a message's state through `Mvu.replaceMvuData`, no MVU event fires. This one does.

**`mvu_helper_res_staged` is a "look again now" signal.** MVU Helper's own POST waits on it. Re-read what you need when it fires, don't take it from the payload. Most cards never need it.

## Flags: is this a real turn?

ST-Prompt-Template renders every lorebook entry again on every page load. From inside an entry, that render looks exactly like a real turn. So an entry that logs a trace, or counts something, fires on a plain browser refresh.

These 2 globals tell them apart:

| Global | Means |
| --- | --- |
| `mvuHelperIsGenerationInFlight` | `true` from the moment a real generation starts until it ends or is stopped. `false` at rest |
| `mvuHelperExtraCallRenderDepth` | a number. Above 0 while MVU Helper is rendering a PRE or POST call's entries |

```ejs
<%_ if (globalThis.mvuHelperIsGenerationInFlight !== false) { _%>
...only on a real turn...
<%_ } _%>
```

**When a flag isn't there, assume it's a real turn.** An older MVU Helper doesn't publish them, and a missing flag should never switch your trace off. That's why the check above is `!== false`, not `=== true`.

## Inside the engine sandbox

Your GameLogic Engine runs in a locked Worker, with no page, no network and no timers. Inside, `globalThis.MvuHelper` is a different, smaller one:

| Member | What it gives you |
| --- | --- |
| `engineInfo()` | your engine's own name, type, version and pack id |
| `log` | the same methods as the page's `log`. Lines print as `[mvu-helper] [engine:game] …` |
| `messages` | which messages exist, never their text: `count(role)`, `at(i)`, `latest(role)`, `find({ role, from, direction, skip })` |

The rest of what your engine gets comes in through its hooks, as `ctx`: the dice, the state, what the reply did. A plugin's engine and an event pack get their own. Each is on its own page:

| Code | What it gets | Page |
| --- | --- | --- |
| your GameLogic Engine | `ctx` in every hook, `ctx.dice` and `ctx.dicePools` | [The hooks in detail](../gamelogic_engine/hooks.md), [Where the engine runs](../gamelogic_engine/runtime.md) |
| a GameLogic Plugin | its `resolveRelay` gets `ops`, the dice, `exposes` matched to its declarations, `engine` and its own drawer | [The plugin engine](../gamelogic_plugin/engine.md#what-it-receives) |
| an event pack | `globalThis.__EVENTPACK__`, left by `eventpack.cjs` for your engine | [Host event packs in your game](../eventpack_engine/host.md) |
| your menu engine | `(args, root)` in every action and input | [The menu engine](../statusmenu_engine/engine.md) |

## Inside the status menu frame

A builder menu runs in a locked frame, with no access to the SillyTavern page. A small prelude runs before it and answers the calls a builder menu makes:

- `getCurrentMessageId`, `getVariables`, `waitGlobalInitialized`,
- `Mvu.getMvuData`, and `Mvu.events.VARIABLE_UPDATE_ENDED` with `eventOn`,
- `_.get` and `_.set`,
- an in-memory `localStorage`.

Plus `MvuHelperFrame`:

| Member | What it gives you |
| --- | --- |
| `lorebookContent(key)` | a promise of one lorebook entry's text, matched by its keys or its comment |
| `messageId()` | the message the menu belongs to |
| `version` | `1` |

The menu never has to poll. MVU Helper pushes the state every time it changes. A button changes variables through an action in your menu engine, never from the frame. See [Where the menu runs](../statusmenu_engine/frame.md#what-a-builder-menu-can-call).

## Entry names MVU Helper reads

MVU Helper finds its own lorebook entries by the tag in their comment:

| Comment | What it is |
| --- | --- |
| `[<callName>]` | a PRE or POST call's prompt. Matched anywhere in the comment or the keys |
| `[<groupTag>]` | a shared group's entry, read by every call in that group |
| `[<callName>] mvu-llm-task:<id>` | a routed task's entry. MVU Helper writes and deletes it |
| `[mvu-helper-char-image] <name>` | a character's look, see [How the character registry works](../roster/registry.md#the-entry) |
| `[Initmvuhelper]` | the card config MVU Helper carries with an exported card |

The entries the installers write, like `[MVU_LogicEngine]` and `[GameLogicPack:<id>] …`, belong to each pack and are on that pack's pages.

## Writing

Nothing on this page writes. Every change goes back to MVU Helper as a list, and MVU Helper writes it through MVU, at the right moment, checked by your schema:

| From | Writes with | Page |
| --- | --- | --- |
| a PRE call | `<JSONPatch>` | [PRE: before the reply](../extra_llm_calls/pre.md) |
| a POST call | `<UpdateVariable>` | [POST: after the reply](../extra_llm_calls/post.md) |
| your GameLogic Engine | what its hooks return | [The hooks in detail](../gamelogic_engine/hooks.md) |
| a plugin | what its `resolveRelay` returns | [The plugin engine](../gamelogic_plugin/engine.md#what-it-returns) |
| a status menu button | what its action returns | [The menu engine](../statusmenu_engine/engine.md#actions-what-a-button-does) |

There is deliberately no macro that sets a variable. When a saved value turns out wrong, you want exactly one place to look.

## Checking your work

Turn on the `pipeline` debug domain on the Main tab, and every call logs what its macros gave it:

```
[PRE2] macros: history::2=1840ch userLine=64ch
```

`∅` means the macro gave nothing. That line is the fastest way to tell "my prompt is wrong" from "the macro gave me nothing". It prints the empty case on purpose, because a macro that silently vanished looks exactly like one you never wrote.

The `smallllm` domain prints the call's whole system block, after every macro is filled in. That's literally what the model saw.

Basically, macros fill in text, the API answers your code, the events tell you when, and every write goes back through MVU Helper.

[Back to Macros and API](README.md) · [Back to index](../../README.md)
