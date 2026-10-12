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

Then `resolveTurn` clears the money report, so a second run would find nothing to apply. Next reply, the entry from step 1 shows the narrator ¥2520. (Why a second run can happen at all is on [One reply, one run](#one-reply-one-run).)

The narrator wrote a scene and reported one number. The engine did the math, kept the rule and saved the result.

### 4. RES2: `resolvePostRelay` picks up what POST recorded

Some things are better recorded after the reply, by POST, than reported by the narrator. ArtificKoi's POST call reads the finished prose and records relationship fallout, like a fight that hurt someone:

```
/Intent/relationship/0  "conflict:<Key>, strain:<Key>:Hurt"
```

After POST's block is applied, MVU Helper calls `resolvePostRelay`. It's the entry point for RES2, and it works the same way as `resolveTurn`: it reads the record, applies the game's rules and returns the new state, in the same reply. ArtificKoi's sets the conflict in her state. That's the conflict EJS puts back in front of the narrator 200 replies later, from the [MVU Squad](../mvu_squad/README.md#what-ejs-does) page.

A good rule for any game: give every channel one owner. In ArtificKoi, the narrator reports money and POST records relationships. If the narrator sends a relationship record anyway, RES1 ignores it with a warning. MVU Helper doesn't enforce this. It's a design choice your engine makes.

`resolvePostRelay` is optional. Without it, POST's changes are still saved, and `resolveTurn` sees them in the next reply.

## One reply, one run

One reply is 5 steps: PRE, the narrator, RES1, POST and RES2. They all have to agree on what happened, and the whole thing has to finish once, in that one reply. Never twice, and never half now and half next reply.

Run the lunch reply twice and the wallet takes -480 twice: ¥3000 becomes ¥2040 for one bento. With affection, a check or the clock, a double run is worse.

### Example: a dice roll in the middle of the prose

The player types "I try to pick the lock." This is how ArtificKoi runs a check, with a lock instead of a heroine. The narrator never invents a number. It's handed the DC and the dice, and both get checked afterwards.

1. **The narrator is shown the DC.** While its prompt is being built, EJS prints a DC ladder worked out from your game's rules: picking this lock is DC 12. The narrator reads the difficulty off the ladder. It never makes one up.
2. **The narrator is shown its dice.** EJS also deals a pool of dice with `MvuHelper.rollPool(8)` and prints them numbered: ①14 ②7 ③19 and so on. The narrator uses them in number order, so its first roll is ①, a 14.
3. **The narrator writes the scene.** Halfway through, it rolls ①14 against DC 12, and the lock clicks open. At the end it reports the check: the DC it used and the die it used.
4. **RES1 checks both.** It gets `ctx.dice`, the same pool, and checks that the reported die really came from it. It works out the DC again from the same rules the ladder came from, and logs it if the narrator used a different number. Then it resolves the check with the real math.
5. **POST and RES2 see the same dice.** If POST's EJS asks for the same pool, it gets the same dice, and RES2 gets the same `ctx.dice`.

The DC, the die, the prose, the state and the receipt all agree, and it's all done in one reply.

Now picture what breaks without that:

- PRE, the narrator and POST each roll their own die. PRE sees a 3, the narrator a 17. The prose says the lock opened, and the state says it didn't.
- The player presses Continue and the dice are rolled again. The second half of the prose argues with the first.
- SillyTavern's Summarize runs a background generation right after the reply, and the dice are dealt again before RES1. RES1 checks the narrator's die against dice the narrator never saw.
- The check resolves one reply late. The narrator already wrote the lock open, while the state still says locked for a whole reply.

It's like a board game night. One person rolls, and everyone at the table reads the same dice. Nobody rolls their own copy, and nobody re-rolls because they looked away for a second.

ArtificKoi has 2 pools. PRE rolls the social checks on its own pool, from a DC ladder for each heroine in the scene, and writes the check into state before the narrator runs. The narrator's pool of 8 is only for the rolls it makes in the prose. Every check is checked the same way afterwards: the engine works out the DC itself, and warns `DIE NOT FROM POOL` when a die didn't come from the pool. Those are warnings, not blocks. The check still applies, and the console says what went wrong, so a model that invents numbers shows up in the log right away.

### When the whole chain happens inside the narrator

Some chains can't wait for PRE or POST. They happen in the middle of the narrator's prose, each step feeding the next. PRE already ran before the prose, and POST only starts after it. Nobody can step in mid-scene.

ArtificKoi's intimate scenes are one. In a single reply:

1. The prose reads where her climax gauge stands.
2. It tries a position, and rolls a die against that position's difficulty. Success or failure.
3. A successful position pushes the gauge further.
4. Whether she can climax in this reply depends on where the gauge ends up.

All 4 steps happen inside one narrator call, and the narrator has to follow the stats the whole way. Before it writes a word, it has to know whether it's even allowed to let her climax.

So the engine works it out before the narrator writes. It computes the branches ahead of time, and EJS puts them in front of the narrator: the gauge right now, the difficulty of each position, the dice to roll against it, and which choices fill the gauge to the top in this reply, if any. ArtificKoi literally prints one of 2 lines: "at the brink, she can climax this reply only with these choices", or "not at the brink, she can't climax this reply, whatever happens".

Then the narrator writes the scene live, following that page, and reports what it did: the choices it made, the raw dice it used, and whether she climaxed. Dice, never verdicts.

RES1 replays the chain with the real math. It works out each success from the dice, fills the gauge, and only accepts the climax if the gauge really got there. A climax the rules didn't allow is refused, and the gauge holds at the brink instead, so she gets there the reply after.

It works like a choose-your-own-adventure book. Every page you could turn to is printed before you start reading. You pick your path live, but you can only land on a page that exists, and someone checks afterwards that you didn't skip one.

That's the pattern for any chain that runs inside the prose: the engine decides what's possible before the narrator writes, the narrator picks a path while writing, and RES1 checks the path afterwards.

### Why the same reply can show up twice

MVU fires the same "a parse finished" event for many things, not only for the narrator's new reply:

- **A re-parse of the same reply.** The narrator's `<UpdateVariable>` block can be applied again to a reply that was already resolved, by a re-render or a stray re-parse. Same reply, same reports, a second event.
- **MVU's floor replay.** About 2 seconds after you delete a message, or when you press MVU's replay button, MVU re-reads around 20 old messages one by one and fires the event for each. Each one looks like a finished turn.
- **MVU Helper's own writes.** A PRE patch, a plugin's write and a status menu button all go through MVU's parse too, and each fires the event.
- **A regenerate.** It replaces the reply in place. Same message number, same swipe, but it's a new reply that must resolve fresh.

If every event called `resolveTurn`, a single reply could be resolved over and over, and a regenerate could be skipped as "already done".

It's like a ticket gate. Somebody has to punch the ticket, or the same ticket gets you through twice. But a new ticket for the same seat on another day has to get through.

### How MVU Helper protects you

MVU Helper sorts every one of those events before your engine sees it:

1. **It remembers which reply it resolved.** It keys each reply by message number and swipe (`mid:swipe`). A second parse of a reply it already resolved never calls `resolveTurn` again. It goes to the RES2 path instead, `resolvePostRelay` and the plugins.
2. **Every new generation starts a fresh count.** A regenerate keeps the same `mid:swipe`, so that memory is cleared on every new generation, and on every chat switch. So a regenerate resolves again instead of being skipped.
3. **It ignores MVU's replay.** It checks where each parse started. A parse of the live turn starts from one of the 2 newest saved states. A replay starts from a message far back, so MVU Helper skips it: nothing is resolved, saved or collected from it.
4. **Its own writes don't count as turns.** While a PRE patch, a plugin write or a status menu button is being applied, MVU Helper holds off resolving. The event that write fires is ignored.
5. **It won't save into the wrong reply.** Right before saving your result, it checks that it's still the same generation, the same reply and the same swipe. If the player swiped or regenerated while your engine was running, the save is skipped. And the save itself doesn't fire the event again, so saving can never trigger another resolve.
6. **Each plugin resolves once per reply.** That guard is MVU Helper's job, never the plugin's.
7. **One deal of dice per generation.** The same pool name and size give the same dice for the whole generation, so PRE, the narrator and POST all read the same die, and RES1 and RES2 get it as `ctx.dice`. Only a new story turn deals again: a new reply, a regenerate or a swipe. A prompt preview, a Continue, a background generation like Summarize, and an impersonate never re-deal.
8. **The steps run in order, in the same reply.** RES1 runs right after the narrator's reply is parsed. POST waits for RES1, so it reads the resolved state, not the state from before the reply. RES2 runs right after POST, still in the same reply.

### What your engine should still do

MVU Helper's memory lives in the page. It's cleared on every new generation, every chat switch and every reload. So add 2 layers of your own, saved with the reply itself:

- **Clear every report you use.** The money report is gone after `resolveTurn`, so a second run finds nothing.
- **Stamp the reply.** At the end of `resolveTurn`, save the reply's key in state. At the start, if the stamp already matches this reply, skip the math. ArtificKoi stamps `Intent.resolvedFor` in RES1 and `Intent.postResolvedFor` in RES2.

Clearing alone isn't enough. A re-applied block puts the reports right back, so the channels you just cleared fill up again. The stamp is what tells your engine "this reply is done."

```js
function resolveTurn(statData, ctx) {
    const key = ctx.mid + ':' + ctx.swipe;               // which reply this is
    const intent = statData.Intent || (statData.Intent = {});
    if (intent.resolvedFor === key) {                    // already done, skip the math
        return { statData, applied: false, log: ['already resolved for ' + key] };
    }
    const log = [];
    // ... read the reports, do the math, clear the reports ...
    intent.resolvedFor = key;                            // stamp this reply
    return { statData, applied: true, log };
}
```

A swipe has a different key, so a swipe resolves fresh. And declare the stamp in your [schema](schema.md), or it's stripped on the next save and protects nothing.

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
- **One reply, one call.** A regenerate or a swipe is a new reply and gets its own call. A PRE patch, a plugin write or a status menu button doesn't call `resolveTurn` at all. Still stamp each reply yourself, see [One reply, one run](#one-reply-one-run).
- **If it throws, the reply isn't resolved.** MVU Helper logs the error and shows a toast.

The other 2 hooks, `preAssemblyPatch` and `pickSameRoundEvent`, and the fine print of these 2, are on [The hooks in detail](hooks.md).

## The technical pages

Read them in this order, or jump to the one you need:

1. [What's in a GameLogic Pack](pack.md) > the folder, `pack.json`, the checks, the smallest pack that works.
2. [The hooks in detail](hooks.md) > the declarations and all 4 hooks.
3. [Where the engine runs](runtime.md) > the sandbox, calling the engine from EJS, logging, dice, an engine in several files.
4. [Entries](entries.md) > the entry file format, and what install does to it.
5. [Schema](schema.md) > the Zod schema, its allowlist and keeping the root open.
6. [Regex](regex.md) > hiding and restyling text, and regexes that change what the model reads.
7. [State corrections](state.md) > fixing values in saves that already exist.
8. [Exposes](exposes.md) > telling plugins where things live in your game.
9. [Import, install and uninstall](install.md) > the library, the dev loop, and what install writes and never touches.

Basically, your entries tell the models what to look at and what to report, and `resolveTurn` and `resolvePostRelay` turn those reports into the game.

[Back to What is GameLogic Engine](README.md) · [Back to index](../../README.md)
