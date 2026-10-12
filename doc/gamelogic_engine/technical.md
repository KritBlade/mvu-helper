# How a GameLogic Engine works

A GameLogic Engine has 2 halves. Lorebook entries tell the models what to look at and what to report. JavaScript, starting with `resolveTurn`, turns those reports into the game.

This page walks through both halves with one real example from ArtificKoi: money.

## A general design, with one real example

Everything on these pages is a general design for any game: RPG, slice of life, zombie hunting, whatever you build. ArtificKoi shows up a lot because it's the first game built on MVU Helper. It's a school dating sim, and it's real and it works, so it makes a better example than something made up.

But the names you see from it are ArtificKoi's own choices, not rules: `Mainchar`, `Classmate`, `CURRENT_VARIABLE_DATA`, `[llmshare]`, money in yen, values stored as `[value, label]` pairs. Your game names things however it wants.

What every game has to follow is only what MVU Helper itself calls and reads: the hooks like `resolveTurn`, the entry prefixes like `[PRE]`, the pack format, and the interface names in `exposes`. Each page says which is which.

One in between: `/Intent` is where ArtificKoi's narrator reports what happened. MVU Helper's event system uses it for one channel, `/Intent/eventFire`. Every other channel under it is your own design.

## It starts with lorebook entries

Lorebook entries are what the models read: your rules, the current state, and what to report back.

You can write the whole game in pure English, with no JavaScript at all, and it would still work. It's just token heavy, and you rely on the LLM to do the judgment calls AND the calculation, which is exactly the part JavaScript is supposed to take off its plate. But pure English does solve one problem: someone with no coding skill at all can still build a game.

Once you add EJS inside an entry, the entry can cherry pick what information goes to the model, based on the game state right now. How EJS works is on the [Tavern Helper, ST-Prompt-Template and MVU](../st_extensions/README.md) page.

## Who reads which entry

The prefix in front of the entry's title decides which model reads it.

- **No prefix** > your main LLM connection profile, the narrator. Same as any normal SillyTavern entry.
- **`[PRE]` or `[POST]`** > the PRE or POST call with that name, set up in the Extra LLM Calls tab. A call named `PRE2` reads `[PRE2]` entries.
- **A shared group tag** > every call in that group. ArtificKoi's `[llmshare]` goes to both PRE and POST.

Disable your PRE and POST entries in SillyTavern. That way SillyTavern never sends them to your main LLM by mistake. MVU Helper still reads and processes them, disabled or not.

ArtificKoi's own entries, as examples:

| Entry | Read by |
| --- | --- |
| `CURRENT_VARIABLE_DATA` | the narrator |
| `[PRE] Social_check_system` | the PRE call |
| `[POST] Story_Analysis_Detail` | the POST call |
| `[llmshare] Classmate_Roster` | both PRE and POST |

The entry file format is on [Entries](entries.md).

## Example: buying lunch in ArtificKoi

### 1. The entry shows the narrator the wallet

ArtificKoi's `CURRENT_VARIABLE_DATA` entry has no prefix, so the narrator reads it. Its EJS prints the real balance and tells the narrator how to report money. Simplified, it looks like this:

```ejs
Wallet ¥<%= getvar("stat_data.Mainchar.Money[0]") %> (his real balance, reference it in the prose)
IF MONEY CHANGED HANDS: /Intent/money/0 "<signed int>", + for earned and - for spent (a ¥480 lunch is "-480").
The engine applies it. You never write Mainchar.Money. Nothing bought or earned, send nothing.
```

The balance isn't typed into the entry. `getvar` reads it from `stat_data` every time the entry is sent, so the narrator always sees the real number, say ¥3000. (The `[0]` is there because ArtificKoi keeps each value together with its description, MVU's `[value, label]` style, and the value comes first. That's ArtificKoi's choice. A game that stores plain values reads `stat_data.Mainchar.Money` with no `[0]`.)

### 2. The narrator writes the scene and reports what happened

The player types "I buy a bento at the school store." The narrator writes the scene, and at the end of the reply it reports:

```xml
<UpdateVariable>
  <JSONPatch>
    [ { "op": "replace", "path": "/Intent/money/0", "value": "-480" } ]
  </JSONPatch>
</UpdateVariable>
```

That's the narrator saying "480 yen left his hands", nothing more. It never touches the wallet itself. (Same `/0` as before, ArtificKoi's value slot. The channel name `money` is ArtificKoi's too. Name your channels whatever fits your game.)

### 3. RES1: `resolveTurn` picks up the report

Every GameLogic Engine needs a function called `resolveTurn`. It's the entry point of your engine. After MVU applies the narrator's report, MVU Helper calls `resolveTurn` once for that reply. This is RES1.

ArtificKoi's `resolveTurn` finds the money report and hands it to `applyMoney`:

```js
function applyMoney(sd, str, log) {
    const delta = parseInt(String(str).replace(/[^0-9-]/g, ''), 10);
    if (isNaN(delta) || delta === 0) { log.push('money ignored (bad/zero delta): ' + str); return; }
    const MC = sd.Mainchar || (sd.Mainchar = {});
    const next = Math.max(0, (Number(get(MC.Money, 0)) || 0) + delta);   // floor 0 (can't go into debt)
    setVal(MC, 'Money', next);
    log.push('MONEY ' + (delta >= 0 ? '+' : '') + delta + ' -> ' + next);
}
```

In plain English:

- It turns the text `"-480"` into the number -480.
- If the report is garbage or zero, it ignores it and says so in the log.
- It adds the number to the wallet, and never lets it go below 0. He can't go into debt.
- It writes the new balance back and logs `MONEY -480 -> 2520`.

Then `resolveTurn` clears the money report, so a second run would find nothing to apply. Next reply, the entry from step 1 shows the narrator ¥2520. (Why a second run can happen at all is on [Same reply protection](same_reply.md#and-only-once).)

The narrator wrote a scene and reported one number. The engine did the math, kept the rule and saved the result.

### 4. RES2: `resolvePostRelay` picks up what POST recorded

Some things are better recorded after the reply, by POST, than reported by the narrator. ArtificKoi's POST call reads the finished prose and records relationship fallout, like a fight that hurt someone:

```
/Intent/relationship/0  "conflict:<Key>, strain:<Key>:Hurt"
```

After POST's block is applied, MVU Helper calls `resolvePostRelay`. It's the entry point for RES2, and it works the same way as `resolveTurn`: it reads the record, applies the game's rules and returns the new state, in the same reply. ArtificKoi's sets the conflict in her state. That's the conflict EJS puts back in front of the narrator 200 replies later, from the [MVU Squad](../mvu_squad/README.md#what-ejs-does) page.

A good rule for any game: give every channel one owner. In ArtificKoi, the narrator reports money and POST records relationships. If the narrator sends a relationship record anyway, RES1 ignores it with a warning. MVU Helper doesn't enforce this. It's a design choice your engine makes.

`resolvePostRelay` is optional. Without it, POST's changes are still saved, and `resolveTurn` sees them in the next reply.

## Same reply protection

Whatever the prose says happened has to happen in that same reply. The prose, the dice, the result and the state all agree. And it happens once, never twice.

Design for this from day one. It decides which step knows what, and when. So adding it later means moving logic all over your engine.

The 4 patterns that make it work, and how MVU Helper keeps every reply to one run, are on [Same reply protection](same_reply.md): a dice roll in the middle of the prose, an event that fires the moment it's ready, a new character the reply she shows up, and a chain that runs inside the prose.

## The 2 entry points

| | `resolveTurn` | `resolvePostRelay` |
| --- | --- | --- |
| Stage | RES1 | RES2 |
| Required | yes | no |
| Runs | after the narrator's reply is parsed | after POST's blocks are applied, same reply |
| Reads | what the narrator reported | what POST recorded |
| Receipt tag | `<RES_Variable>` | `<RES_POST_Variable>`, right after RES1's |

Both are called as `(statData, ctx)` and return the same shape.

What they receive:

- `statData` > the game state for this reply.
- `ctx.mid`, `ctx.swipe` > which message and which swipe this is.
- `ctx.dice`, `ctx.dicePools` > the dice rolled this reply, the same ones the model was shown. `null` when none were rolled.
- `ctx.ops` > every state change parsed this reply, and who made it (`message`, `pre-sim`, `post`, a plugin, a status menu). Your own changes never show up here.
- `ctx.sameRoundEventKey` > `resolveTurn` only. The event played in this reply, `''` when none.

What they return:

- `statData` > the new state. It replaces the reply's state.
- `applied` > `true` when you changed something. MVU Helper only saves when it's `true`.
- `log` > lines for the console, for you.
- `resBlock` > the receipt the player sees in the reply. MVU Helper wraps it in the receipt tag, so don't write the tags yourself.
- `textReplacements` > optional `{ find: replace }` pairs applied to the reply's text. ArtificKoi uses it to fill in the date and the location.

Watch out for a few things:

- **Return what you changed.** Every call crosses into the sandbox as a copy. Changing `statData` without returning it changes nothing.
- **One reply, one call.** A regenerate or a swipe is a new reply and gets its own call. A PRE patch, a plugin write or a status menu button doesn't call `resolveTurn` at all. Still stamp each reply yourself, see [Same reply protection](same_reply.md#what-your-engine-should-still-do).
- **If it throws, the reply isn't resolved.** MVU Helper logs the error and shows a toast.

The other 2 hooks, `preAssemblyPatch` and `pickSameRoundEvent`, and the fine print of these 2, are on [The hooks in detail](hooks.md).

## The technical pages

Read them in this order, or jump to the one you need:

1. [Same reply protection](same_reply.md) > read this one first. The prose, the dice and the result in one reply, and only once.
2. [What's in a GameLogic Pack](pack.md) > the folder, `pack.json`, the checks, the smallest pack that works.
3. [The hooks in detail](hooks.md) > the declarations and all 4 hooks.
4. [Where the engine runs](runtime.md) > the sandbox, calling the engine from EJS, logging, dice, an engine in several files.
5. [Entries](entries.md) > the entry file format, and what install does to it.
6. [Schema](schema.md) > the Zod schema, its allowlist and keeping the root open.
7. [Regex](regex.md) > hiding and restyling text, and regexes that change what the model reads.
8. [State corrections](state.md) > fixing values in saves that already exist.
9. [Exposes](exposes.md) > telling plugins where things live in your game.
10. [Import, install and uninstall](install.md) > the library, the dev loop, and what install writes and never touches.

Basically, your entries tell the models what to look at and what to report, and `resolveTurn` and `resolvePostRelay` turn those reports into the game.

[Back to What is GameLogic Engine](README.md) · [Back to index](../../README.md)
