# Ship it with your card

> This page applies to any card. ArtificKoi shows up as a real example, not as a rule.

You don't want every player to set up pictures by hand. So the card carries its picture setup in `[Initmvuhelper]`, the same lorebook entry that carries your Extra LLM Calls.

## What travels with your card

Set it up on the Image Generation tab, then Main tab > Card config > **Export to card**. The `imagegen` section goes into `[Initmvuhelper]`.

| Kind | Fields | First load | A card upgrade |
| --- | --- | --- | --- |
| the card's | `intimacyLatchPath`, `maincharRegistryKey`, `promptTemplate`, `promptRegex`, `promptPosition`, `promptDepth` | from the card | refreshed from the card |
| the player's | `insertType`, `defaultImageType`, `maxImagesPerReply`, `maxCharactersPerImage`, `stripPicTag`, `hBlockAlwaysOn` | from the card | kept as the player set them |
| never travels | `sdPromptPrefixPresetId` | never | never |

The card's fields are facts about your card: where its latch lives, which entry holds the main character, and the contract it teaches. The player's fields are preferences, so your values are only where a new player starts.

The prefix pick never travels, because it points into the player's own preset list. And your PC's settings, streaming, queue, prefix presets, bust and resolution, have no place in the config at all. A card that shipped them would resize pictures to fit a stranger's GPU.

## The 2 fields every card should set

ArtificKoi's whole `imagegen` section is these 2 lines:

```json
"imagegen": {
  "intimacyLatchPath": "PendingState.IntimacyActive",
  "maincharRegistryKey": "Mainchar"
}
```

MVU Helper ships both blank on purpose. It's a platform, and it doesn't know any card's game state or its main character. A default naming one card's path would point at nothing on every other card.

So a card that leaves them out gets:

- **no latch:** the explicit rules on every reply, SFW or not,
- **no main character entry:** the main character drawn from the scene words alone, a different person in every picture.

A path you name has to exist in your game state. Rename a root and keep the old path, and the latch quietly stops working. MVU Helper warns with the path in the message, see [What the AI is sent](prompt.md#explicit_rules-and-the-gate).

## Your own contract

Leave `promptTemplate` and `promptRegex` out, and your card sends the built-in ones, which follow MVU Helper's updates.

Ship your own only when you really need to. Keep `{{maxImages}}` and `{{castRules}}` in it. The other rules, outfits, picture count, camera and explicit, are added from code whatever your template says.

A card upgrade that changes the template reaches every player on their next chat load, because it's the card's field.

## Old fields

These used to exist. A card that still carries one gets it named in the console on import, with the reason, and the field is ignored:

| Field | Why it's gone |
| --- | --- |
| `forceImageTypePath` | every picture is drawn at the card's Image type now |
| `storyDatePath`, `defaultOutfits` | every picture names what each person wears |
| `maleRegistryKey` | renamed `maincharRegistryKey` |
| `maxGirlsPerImage` | renamed `maxCharactersPerImage` |
| `teachNarrator` | Image insert type decides whether the contract is sent |

## The state MVU Helper keeps

What each person wore in their last picture lives in your card's own state, under MVU Helper's root:

```json
"mvuhelper": {
  "worn_outfit": {
    "Mitsuki":  { "outfit": "school-uniform", "clothes": "", "last_picture_message": 42 },
    "Mainchar": { "outfit": "school-uniform", "clothes": "", "last_picture_message": 42 }
  }
}
```

| Field | What it holds |
| --- | --- |
| `outfit` | an outfit on file, or `newclothes` for a one-off |
| `clothes` | the one-off's clothes. Empty for an outfit on file |
| `last_picture_message` | the message of their last picture |

It's written at the end of every reply while pictures are drawn. MVU saves the state with every message and every swipe, so a swipe, a regenerate, a deleted reply and a reload are all right by themselves. Nothing reads old reply text to rebuild it.

That's what `same-as-last-picture` draws. Someone no picture has drawn in more than 100 replies is dropped at the end of a reply, so the record never keeps everyone ever drawn in a long chat.

**Declare it in your Zod schema.** A schema that strips roots it doesn't list strips `mvuhelper` too, and then nothing anyone wore is ever offered back. The console says so once per chat. A schema that keeps the record but strips `last_picture_message` loses every entry at the end of the reply, and the console names that field.

## Checking your work

Turn on **Image gen** in the Debug card of MVU Helper's Main tab.

| You see | It means |
| --- | --- |
| `gen [landscape 1152x768] drawn=…` | one line per picture, with what the AI wrote and what `/sd` got. Read it on [From tag to `/sd`](drawing.md#checking-a-picture) |
| `injecting image prompt: …` | the rules went into the prompt, and where `<scene_roster>` went |
| `<explicit_rules> ON (…)` or `OFF (…)` | what the gate decided, and why |
| `msg 12 carries NO <pic> tag` | the AI skipped the contract this reply |

Some things are warned whatever the debug setting:

- someone drawn with no look anywhere,
- people left out over the ceiling,
- a missing `mainchar=` or `camera=`, or an unknown camera,
- appearance words dropped from a composition,
- tags over the cap,
- a latch path that isn't in the game state,
- a picture another writer erased.

A reply with no tag at all is the one to watch. The contract makes a tag mandatory every reply, so no tag means the AI dropped the instruction. Usually the card's own output format crowds it out, or a custom template lost a rule.

Basically, ship the latch path and the main character entry, declare `mvuhelper` in your schema, and the rest follows MVU Helper.

[Back to How Auto Image Generation works](technical.md) · [Back to index](../../README.md)
