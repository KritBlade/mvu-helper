# From tag to `/sd`

> This page applies to any card. ArtificKoi shows up as a real example, not as a rule.

A tag becomes a job in a queue. When the job runs, MVU Helper builds the full image prompt and calls SillyTavern's `/sd`. The insert modes and what happens to the reply are on [Where the picture goes](placing.md).

## When drawing starts

There are 2 ways a tag gets drawn, and they share one job:

- **streaming pre-generation**, while the reply is still streaming,
- **the draw pass**, once the reply is received.

Whichever sees a tag first creates the job, and the other one waits on it. So a streamed picture is drawn once, not twice.

It's like ordering coffee while you're still in line. By the time you reach the counter it's already made, and nobody makes you a second cup.

Pre-generation draws a tag mid-stream only when all of these hold:

- **Streaming pre-generation** is on, and Image Insert Type draws,
- the mode isn't Create New Message. `/sd` posts that picture as its own message, so the draw pass has to start it,
- the tag is complete,
- it isn't inside an unfinished `<think>` block. Draft tags in the AI's reasoning don't count,
- everyone in its slots has a look MVU Helper can build right now. A look that only arrives with the end of the reply can't exist mid-stream, so that tag waits for the draw pass.

The main character never makes a tag wait. Their look is their entry, and it's either there or not.

A job that fails during the stream isn't retried on every new token. The draw pass gives it one more try.

## The cap

The draw pass takes the first tags in text order, up to the card's Max images per reply. The rest aren't drawn, and the console says so once for that message.

In Inline Replace Mode, a tag over the cap doesn't stay in the reply as raw markup, see [Where the picture goes](placing.md#leftovers-in-inline-replace-mode).

## The queue

**Queue concurrency**, 1 to 4, is how many `/sd` calls run at the same time. Everything else waits its turn in order.

Each job is identified by its message, everyone in the tag with their outfit, the main character's outfit, the camera and the composition. 2 tags with the same composition but someone else in them, other clothes or another angle are 2 different pictures.

A job that fails is never kept. A missing `/sd`, an empty result, an error or a cancelled job all forget the job, so a swipe or a regenerate draws it fresh instead of joining the failure.

A swipe, a chat switch and a delete drop every job still waiting in the queue. A delete clears everything, because messages are tracked by their position, and a delete shifts every position after it.

## Building the prompt

The prompt is built when the job RUNS, not when the tag was seen. So what each person wore in their last picture is current, even for a job that waited in the queue.

```
<prefix>, <camera words>, <composition>. <each person's look> <the main character's look>
```

### 1. The prefix

The card's **/sd prompt prefix** preset, then `, `. A comma or period at the end of the preset is dropped first, so the joint never reads `,,`. With none picked, there's no prefix.

A card that points at a preset that no longer exists draws with no prefix, and the console says so.

### 2. The camera

The words of the tag's `camera=` go at the start of the composition, see [The `<pic>` tag](pic-tag.md#the-camera).

### 3. The cleanup

Fixed appearance words in the composition are dropped, only when everyone in the shot has a look. See [The cleanup](pic-tag.md#the-cleanup).

### 4. Each person's look

One person in the shot:

```
The person in the frame is Mitsuki: [Mitsuki] <body>, <clothes> [/Mitsuki]
```

More than one:

```
Mitsuki is: [Mitsuki] <body>, <clothes> [/Mitsuki] Mana is: [Mana] <body>, <clothes> [/Mana]
```

Clothes everyone wears word for word, like a card's shared school uniform, are said once: `Both wear: …` for 2, `All 3 wear: …` for 3. Then each look follows without them.

Each look comes from that person's saved look, in the outfit the slot names. Someone with no look anywhere is left out here, and drawn from the composition alone. The console names them, because that's the one way a named character comes out as a stranger.

### 5. The main character

The main character's look always closes the prompt:

```
The main character in the frame is [main character] <body>, <clothes> [/main character]
```

Only when their `mainchar=` names an outfit, and the card names a main character entry with a look in it.

### 6. Scenery

A tag with nobody named and no main character sends the prefix, the camera words and the composition, nothing else. No cleanup runs, because there's no look for anything to fight.

### Why the name tags

The image models this is written for read the prompt with an LLM text encoder, not the old 77 token CLIP. An LLM encoder ties each description to the subject of its sentence. Glue 2 looks together plainly, and they bleed: one girl's leggings end up on the other, or both get one face.

Naming each look's owner is what keeps it apart, and the closing tag marks where it ends. I measured it on Krea 2: with the tags, and the main character called "the main character", 11 or 12 of 12 seeds drew everyone right. The named sentences alone got 8 of 12.

Where anyone stands is never said here. Only the composition says that. A position here would be a second claim, and it would contradict the composition whenever the slot order differs.

A period inside a look's text becomes a comma, so a look never ends early. A decimal like `(golden eyes:1.1)` is kept. And nothing here names a gender: what each person is comes from the first tag of their own look.

### Over the ceiling

Before anything is built, the people are cut to the card's Max characters with DNA per image:

1. a name in 2 slots counts once,
2. over the ceiling, the main character goes first,
3. then the last slots, one by one.

Everyone left out is named in the console. They're drawn from the composition alone, if it still describes them.

## The size

Every picture is drawn at the card's **Image type**, with that type's width and height from **Resolution presets**. A `type=` on the tag is ignored, so every picture on a card shares one shape, redraws included.

## The bust variable

With **Send bust multiplier to the backend** on, each job writes one number into a SillyTavern chat variable right before its `/sd` call:

```
/setvar key=bust_strength 1.7
```

| People in the picture with a `[Bust]` | Number sent |
| --- | --- |
| nobody | the **Default**, 1 |
| 1 | theirs |
| 2 or more | the **Shared value**, 1.5 |

It's written per job, right before the call, never once per reply. Pre-generation queues jobs early, so a value written when the tag was seen would belong to another picture by the time this one runs.

That's also why it needs Queue concurrency 1. There's one variable, and 2 jobs running at once would overwrite each other's number.

A blank variable name skips it with a warning. Off, and nothing is written, so the workflow keeps whatever value it already had.

## The call

MVU Helper calls `/sd`, or `/imagine` when that's what's there, with the width, the height and the full prompt. It runs quiet, so SillyTavern posts nothing itself, except on Create New Message, where `/sd` posts the picture as its own message.

No `/sd` command at all means SillyTavern's Image Generation isn't set up, and that's warned. An empty answer is "no image", warned with the tag.

## Checking a picture

Turn on the **Image gen** debug domain in the Main tab. Every job logs one line before it calls `/sd`:

```
gen [landscape 1152x768] drawn=1:"Mitsuki"[school-uniform|body stored|clothes stored] mainchar="Mainchar"[school-uniform|body stored|clothes stored] camera=eye-level ("eye level" added) prefix="Default" bust=1.7
  composition: 1girl, 1boy, sitting side by side on a bench, …
  → sent to /sd: masterpiece, best quality, …
```

| Part | What it tells you |
| --- | --- |
| `drawn=` | who was resolved, in slot order: the outfit the tag wrote, and where their body and clothes came from. `NO LOOK` means drawn from the scene alone |
| `mainchar=` | the main character the same way, or `not-in-picture`, `none written` or `dropped (over the ceiling)` |
| `camera=` | the value, and whether its words were added or already in the composition |
| `prefix=` | the preset name, `none`, or `MISSING:<id>` for a preset that's gone |
| `bust=` | the number sent, or `off` |
| `composition:` | exactly what the AI wrote |
| `sent to /sd:` | exactly what the image model got |

Comparing the last 2 lines is the fastest way to tell "the AI wrote a bad shot" from "the look is wrong".

Basically, a tag waits its turn, gets its prompt built at the last moment, and goes to `/sd` at the card's size.

[Back to How Auto Image Generation works](technical.md) · [Back to index](../../README.md)
