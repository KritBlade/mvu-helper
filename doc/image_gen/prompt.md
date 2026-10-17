# What the AI is sent

> This page applies to any card. ArtificKoi shows up as a real example, not as a rule.

While Image Insert Type is anything but Disable, every prompt SillyTavern builds gets the picture rules added. MVU Helper adds them when SillyTavern's Chat Completion prompt is ready, so it takes a Chat Completion API. The saved chat is never changed, only the prompt that goes out.

## One block at the very top

The fixed rules go out as ONE system message, at the very top of the prompt, in this order:

1. the contract, the Image tab's **Prompt Template**, with its 2 placeholders filled in,
2. `<outfit_rules>`,
3. `<picture_count>`,
4. `<camera>`,
5. `<explicit_rules>`, only when the gate lets it through.

Why the top: a provider's prompt cache reuses a prompt up to its first changed character. These rules read the same on every reply, so they go first and get cached. `<explicit_rules>` goes last, because it comes and goes with an intimate scene, and it only costs the cache from its own place on.

Think of a printed menu and the specials board. The menu is the same every day, so it's printed once. The specials change, so they go on the board at the end, not in the middle of the menu.

## The contract and its 2 placeholders

| Placeholder | Filled with |
| --- | --- |
| `{{maxImages}}` | the card's Max images per reply |
| `{{castRules}}` | the `[CAST]` block, built from Max characters with DNA per image and the main character's outfits |

A card with its own template should keep both. A template without `{{castRules}}` never tells the AI how many people a picture may hold.

A blank template means the built-in one. Text identical to the built-in one is saved as blank too. So a card that never changed it always sends the contract the installed MVU Helper ships, and a better contract in a later version reaches it by itself.

The other 4 blocks ship from code, whatever the template says. A saved copy of a template goes stale. A rule that lived only in that copy would never reach the cards that saved one.

## `[CAST]`: who may be in one picture

Built per card from Max characters with DNA per image. It's a ceiling, never a target. One person alone is a normal shot, and nobody is added to reach the number.

At a ceiling of 1, it's one person per picture: one named character, or the main character, never both. When 2 people touch, the shot shows one of them alone, or it's shot pov when one of them is the main character.

At 2 or more, each named person takes a slot, and the AI is shown the 2 shapes to copy:

```
two named characters: <pic char="CharKey" outfit="CharOutfit" char2="Char2Key" outfit2="Char2Outfit" camera="Camera" prompt="[Composition] your text" mainchar="not-in-picture">
a named character with {{user}}: <pic char="CharKey" outfit="CharOutfit" camera="Camera" prompt="[Composition] your text" mainchar="UserOutfit">
```

Both shapes are shown on purpose. With only the first one, an AI drawing the main character with one girl copied the 1 person shape, left `mainchar=` off, and the image model drew a stranger in his place.

The rules that come with it:

- **Everyone the count tag counts is in the tag.** A named character in a slot, the main character as an outfit in `mainchar=`. Only an unnamed stranger stays out.
- **A body part brings its owner**, except the main character's pov hands. See [The `<pic>` tag](pic-tag.md#the-main-character).
- **Keep them separable.** Each person in their own clause, by name, doing their own thing: "Mitsuki leaning back on the desk, grinning, Mana standing beside Mitsuki, hands clasped". Never one shared subject like "both smiling", because that's the shape that bleeds.

The main character's values come from their entry's outfits. `default` is offered only when that entry has a plain `[Clothes]`, or when the card names no entry at all. An entry with only named outfits has no default, and `mainchar="default"` would draw him with no clothes.

## `<picture_count>`

Built from Max images per reply.

At 1: "ONE `<pic>` this reply. With more than one scene, it goes to the scene you choose."

At 2 or more, it's an instruction, not a judgment call:

- a scene change gets another `<pic>`: another place, a jump in time, someone new arriving,
- the last scene always gets one, because it's where the story stands now,
- no scene change, no extra tag. A new pose or more talk adds nothing.

It's written this way because a judgment doesn't work. Ask any AI whether a beat "earns" a picture, and it answers one tag, every single time.

So the number is a ceiling, never a target. The scenes decide how many tags a reply gets. A reply that never leaves one room gets 1, whatever the number says, and nothing is re-shot just to fill the count.

The draw pass enforces the number anyway. Tags past it aren't drawn, see [From tag to `/sd`](drawing.md#the-cap).

## `<outfit_rules>`

It opens with WHY: MVU Helper, not the image model, dresses each person. It reads `outfit=` word for word, so every slot needs one of the values, written exactly, in English. The values are on [The `<pic>` tag](pic-tag.md#outfits).

A model told how it works picks the right value by itself. So the block explains it instead of listing examples.

## `<camera>`

The 7 camera choices, the rule that only pov keeps the main character out, and `mainchar=` on every tag, written last. All on [The `<pic>` tag](pic-tag.md#the-camera).

## `<explicit_rules>` and the gate

The explicit rules are the floor every adult scene needs, whatever the story:

- the `nsfw` tag, or `explicit` for penetration, because the safety tag is a real signal to the image model,
- exposure named exactly, because the image model can't guess nudity. `outfit="undressed"` means the composition must say the state of undress,
- every position written as body arrangement, never its name. Who is over, under or behind, which limb where, and exact contact.

A card that wants its own camera recipes per position adds them itself, gated on the same latch.

The block is big, and a normal reply doesn't need it. So it's gated on a true/false value in the card's game state, the **Intimacy latch path**. ArtificKoi's is `PendingState.IntimacyActive`.

| State | `<explicit_rules>` |
| --- | --- |
| **Always inject H guidance** ticked | sent, the latch isn't even read |
| path blank | sent. A card with no latch claims nothing about its turns, and a non-MVU card has no state to read |
| path found, reads `false` | not sent |
| path found, reads anything else | sent |
| path set, no game state loaded yet | not sent |
| path set, not found in the game state | not sent, and a warning names the path |

The path is a dot path under `stat_data`. A leading `stat_data.` is allowed, so are `[n]` indexes, and an MVU `[value, "label"]` pair is unwrapped to its value.

The last state fails closed on purpose. A card that set a path asked for a gate. Fail-closed is easy to see: an intimate picture comes out without the explicit floor, and the warning names the path. Fail-open is invisible: every SFW reply quietly carries the explicit rules.

A path that isn't found is warned once per path, practice prompts included. "No game state yet" is warned only on a real reply. SillyTavern builds a practice prompt on every chat load to count tokens, usually before MVU has started, and nothing it builds is sent.

## `<scene_roster>`

On a card whose game state tracks who is in the scene, one more block lists who's on screen right now, one key per line:

```
<scene_roster>
On-screen now (game state):
- Mitsuki
- Mana
…
</scene_roster>
```

It's not a limit on who can be drawn. Anyone the story names in the scene can be drawn, listed or not. And each line is the key the game files that character under, never a spelling to copy into `char=`. A game whose keys are romanized while the story is in Chinese still gets the story's spelling in `char=`.

It changes with who's on screen, so it doesn't go in the cached block at the top. **Position** picks its role (system by default, user or AI), and **Depth** how many messages back from the end it goes. 0, the default, is the very end.

When the game state names nobody on screen, the block isn't sent at all.

## The chat history: pictures go back to tags

Before the prompt goes out, every rendered picture in the chat history is turned back into the `<pic>` it came from. Only in the outgoing prompt, the saved messages are never touched.

Here's why. An AI that sees `<span class="auto-img-wrap"><img src="…">` in its past replies copies it. You get made-up file names that never load, and full wrap markup instead of a tag. Shown its own tags instead, it learns the right shape from the chat itself.

Basically, the rules that never change sit at the top and get cached, the gate decides about the explicit block, and the AI only ever sees tags, never HTML.

[Back to How Auto Image Generation works](technical.md) · [Back to index](../../README.md)
