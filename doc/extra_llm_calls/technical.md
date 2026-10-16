# How Extra LLM Calls work

A call is 3 things: a name, a phase and a connection profile. Its prompt is every lorebook entry tagged with its name. A PRE call's answer goes into the prompt the narrator reads, and a POST call's answer goes into the save.

This page follows one reply through PRE and POST. The pages with the details come first.

## The technical pages

Read them in this order, or jump to the one you need:

1. [Set up the calls](calls.md) > the tab field by field, shared groups, and what travels with your card.
2. [What a call reads](prompts.md) > routing by `[name]`, EJS1 and EJS3, the user's line, the reply, OOC commands and the `{{mvuhelper::…}}` macros.
3. [PRE: before the reply](pre.md) > fan out, the note for the narrator, writing state with `<JSONPatch>`, same-round events.
4. [POST: after the reply](post.md) > waiting for RES1, `<UpdateVariable>`, the receipt, reading PRE's answer, the developer API.
5. [Swipe, regenerate, stop and delete](swipe.md) > how all 3 LLM calls stay on the same reply.

Where the calls sit among your engine's hooks is on [MVU Squad](../mvu_squad/README.md).

## The parts

| Part | What it is | Where it lives |
| --- | --- | --- |
| a call | a name, a phase (PRE or POST) and a connection profile | the Extra LLM Calls tab, per card |
| `[name]` entries | the call's prompt | the card's lorebook |
| a shared group | entries several calls read, written once | a `[tag]` in the tab, and `[tag]` entries in the lorebook |
| EJS1, EJS3 | the EJS inside PRE and POST entries, rendered by MVU Helper | the entries themselves |
| PRE's prose | a note for the narrator, this reply only | the prompt copy of your last line. Never saved |
| PRE's `<JSONPatch>` | a state write, before the narrator runs | `stat_data` on your line's message |
| POST's `<UpdateVariable>` | a state write, after the reply | the reply, as `<POSTUpdateVariable>`, applied through MVU |
| `lastPre`, `lastPost` | every call's raw answer this turn | `globalThis.mvuHelper` |
| `[Initmvuhelper]` | your card's MVU Helper setup, so players get your calls | the card's lorebook |

Extra LLM Calls needs SillyTavern's Connection Manager. Every call goes out through it.

## One reply, start to finish

Take ArtificKoi. It has 2 calls, `PRE` and `POST`, and a shared group `llmshare` that both of them are in.

You type: "I ask Mitsuki to have lunch with me."

### 1. PRE builds its prompt

MVU Helper collects every lorebook entry tagged `[llmshare]` or `[PRE]`, like `[llmshare] Classmate_Roster` and `[PRE] Social_check_system`. It sorts them by order, renders their EJS against the save as it stood before your line (that's EJS1), and sends 2 messages to the PRE call's connection profile:

- **system:** the rendered entries,
- **user:** your line.

### 2. Every PRE call runs at once

With more than one PRE call, they all fan out at the same time, and MVU Helper waits for every one of them before the narrator starts. Calls on the same profile take turns. A call that times out counts as empty, and the rest go on.

### 3. PRE's answers land in 2 places

Each answer is split in 2:

- **the prose** goes onto your line in the prompt copy, wrapped as `[PRE]…[/PRE]`. The narrator reads it as part of your turn. It's never saved, and never shown in the chat.
- **a `<JSONPatch>` block,** if there is one, is a real write to the save, applied right now. The narrator already writes from the new state.

### 4. The narrator writes the reply

Your main model writes, reading your line with PRE's note on top. It reports what happened on `/Intent`, and RES1, your engine's `resolveTurn`, turns that into numbers.

### 5. POST builds its prompt

POST waits for RES1 first, so it sees the resolved state. Then it collects every `[llmshare]` and `[POST]` entry, renders their EJS against the reply (that's EJS3), and sends:

- **system:** the rendered entries, plus your OOC commands, if your line had any,
- **user:** the finished reply, minus every patch block and the stat box.

### 6. POST's answer goes into the save

If POST's answer has an `<UpdateVariable>` block, MVU Helper writes it into the reply as `<POSTUpdateVariable>`, as the player's receipt, and applies it through MVU. RES2, your engine's `resolvePostRelay`, settles it in the same reply.

The reply is done, and the next one starts from the state all 3 calls agreed on.

## What each answer can do

| | The prose | A patch block |
| --- | --- | --- |
| PRE | a note the narrator reads, this reply only | `<JSONPatch>`: a state write, before the narrator runs |
| POST | lands in `lastPost`, for your own code | `<UpdateVariable>`: a state write, after the reply |

There's no switch for any of it. The answer decides. A call whose answer has a patch block writes state, and one without it doesn't.

Basically, the lorebook is the prompt, the call's name is the address, and the phase decides where the answer goes.

[Back to Extra LLM Calls](README.md) · [Back to index](../../README.md)
