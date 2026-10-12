# Same reply protection

> This page applies to any game. ArtificKoi shows up as a real example, not as a rule. See [A general design, with one real example](technical.md#a-general-design-with-one-real-example).

Same reply protection means whatever the prose says happened, happened in that same reply. The prose, the dice, the result and the state all agree, and the whole thing finishes in 1 single run. Never a reply late, and never twice.

It sounds obvious. But an engine doesn't do it on its own. You have to design for it.

## Design it in from day one

Same reply protection decides where each piece of your logic lives: which step knows what, and when. So it's not a feature you add at the end. It's the shape of your whole engine.

I learned this the hard way. ArtificKoi didn't start this way, and making it work later meant a LOT of refactoring and redesign. Logic had to move from after the narrator to before it. Entries got rewritten. Report channels changed. Every mechanic was touched.

It's like the plumbing in a house. Put the pipes in before the walls go up, and it's easy. Add them after, and you're tearing walls open in every room.

## The one question to ask

For every mechanic in your game, ask: when does the narrator need the result?

The narrator writes the whole reply in one go, and nothing runs while it writes. PRE runs before it, RES1 after it. So if the prose needs a result halfway through, nobody can hand it over halfway through. The answer has to be in front of the narrator before it writes a word.

Get this wrong and you get the "one reply late" bug. The narrator writes something, and the state only catches up on the next reply. The player sees it as the game ignoring what just happened.

The 4 patterns below are the 4 ways ArtificKoi answers that question.

## Pattern 1: a dice roll in the middle of the prose

A roll happens in the prose, and its result lands in the same reply. The narrator never invents a number. It's handed the DC and the dice, and both get checked afterwards.

The player types "I try to pick the lock."

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

## Pattern 2: an event that fires the moment it's ready

An event plays in the reply where its last condition comes true. Not the reply after.

Mia told him "meet me at the library after school." It's after school now. The player types "I head to the library."

Without same reply protection, the narrator writes him walking into an empty library. RES1 moves him there, sees every condition is met, and arms the event for later. Mia only shows up on the next reply, maybe right after the player typed "I grab a book and leave." The scene answers a reply late.

With it, the decision moves to before the narrator:

1. **PRE is shown what's close.** A `[PRE]` entry lists the events that are one condition away from firing. Mia's meeting is on it: it needs him at the library.
2. **PRE reports what the player's line does.** He's heading to the library. PRE reports that in its output. It doesn't decide anything.
3. **Your engine picks.** MVU Helper calls your engine's `pickSameRoundEvent` with every PRE output. Your engine checks Mia's conditions against where he's heading, and returns her event's key.
4. **MVU Helper plays it.** It finds that event's body in your lorebook and puts it in front of the narrator for this reply.
5. **The narrator writes the meeting** and reports that the event fired.
6. **RES1 checks it for real.** It checks the event's conditions again and fires it: the rewards, the record, marked done. `ctx.sameRoundEventKey` tells it which event was played, so it can warn when one was played but never fired.

It's like a friend who texts "I'm outside" the moment they pull up. You don't want that text to show up after they've already left.

The PRE output field and its rules live in your `[PRE]` entries. `pickSameRoundEvent` is exported from your engine. Don't export it, and events still work, they just play a reply late. The details are on [The hooks in detail](hooks.md#picksameroundevent).

ArtificKoi's PRE call reports 2 fields: `eventReady`, the event this reply can carry or `none`, and `destination`, where the player's line takes him. PRE never judges a place. A small model once said yes to the wrong courtyard, and the beat played where it could never fire. So the engine checks the place itself, and RES1 checks everything again before it fires. A wrong pick costs a scene that plays again later. ArtificKoi warns `SAME-ROUND MISS` or `SAME-ROUND LOST` when a played event didn't fire.

## Pattern 3: a new character, the reply she shows up

A new character gets her record in the same reply she first walks into the scene. So everything else in that reply can already use her.

The player is at the café, and a girl he's never met sits down at his table.

Without same reply protection, the narrator writes her in, but she isn't in the state yet. If he flirts with her in that same reply, the check has nobody to land on. Her affection, her mood, where she is, all of it waits a reply. And the status menu doesn't show her until the reply after she spoke.

With it:

1. **The build instructions come with her.** Her character entry loads when her name shows up, like any lorebook entry. Inside that same entry, EJS prints a short note, but only while she isn't in the state yet: "she's new, if she's in the scene, build her this reply." Once she's built, the note prints nothing.
2. **The narrator writes the scene** and reports her whole record on one channel, copied from her character entry.
3. **RES1 builds her first.** Before checks, before presence, before any other report. So a flirt check on her in that same reply lands on a real record.

It's like a new student on the first day. The teacher adds her to the roll call before class starts, not at the end of the week. Otherwise every attendance check that week has a gap.

The note rides in her own entry on purpose. Her stats live in that entry, so the order to build her can never show up without the stats beside it.

ArtificKoi's note is `NEW HEROINE NOT BUILT YET`. It tells the narrator to build her only when she's on stage, and to leave her alone when she's only mentioned. The channel is `/Intent/newClassmate`, and RES1 builds it as step 0. As a backup, when POST sees a girl on stage who still isn't built, it arms her, and a banner asks the narrator to build her on the next reply.

## Pattern 4: a chain that runs inside the prose

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

## And only once

The other half of same reply protection: the run happens once. Run the lunch reply from [How a GameLogic Engine works](technical.md#example-buying-lunch-in-artifickoi) twice, and the wallet takes -480 twice: ¥3000 becomes ¥2040 for one bento. With affection, a check or the clock, a double run is worse.

This half is mostly MVU Helper's job. Your engine adds a small backup.

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

A swipe has a different key, so a swipe resolves fresh. The stamp is a field in `stat_data`, so declare it in your [schema](schema.md), or it's stripped on the next save and protects nothing.

## Who does what

| Piece | Who |
| --- | --- |
| Dealing the dice once per generation, and the same dice to every step | MVU Helper |
| Running PRE, the narrator, RES1, POST and RES2 in order, in the same reply | MVU Helper |
| Playing a picked event's body in this reply | MVU Helper |
| Never resolving the same reply twice | MVU Helper, with your stamp as the backup |
| What the narrator is shown before it writes: the DC ladder, the event candidates, the build note, the branches | your entries and your engine |
| Picking the event to play now | your engine (`pickSameRoundEvent`) |
| Checking every report afterwards, with the real math | your engine (RES1 and RES2) |

MVU Helper gives you the plumbing. It can't do the rest, because it doesn't know your game. It doesn't know a lock is DC 12, or that Mia is waiting at the library. Only your rules know that.

Basically, MVU Helper makes sure every reply runs once, in order, with one set of dice. Your engine makes sure everything the prose needs is in front of the narrator before it writes, and checks it after.

[Back to How a GameLogic Engine works](technical.md) · [Back to index](../../README.md)
