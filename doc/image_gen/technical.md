# How Auto Image Generation works

A picture is one `<pic>` tag the AI writes into its reply. MVU Helper finds the tag, builds the image prompt from it, hands that to SillyTavern's `/sd`, and puts the picture where the tag was.

This page follows one picture from the prompt to the chat. The pages with the details come first.

## The technical pages

Read them in this order, or jump to the one you need:

1. [The `<pic>` tag](pic-tag.md) > every attribute, the composition, the camera, outfits, the main character, and how a tag is found.
2. [What the AI is sent](prompt.md) > the contract, the fixed rules, the explicit gate, the on-screen list and the prompt cache.
3. [From tag to `/sd`](drawing.md) > when drawing starts, the queue, how the image prompt is built, the size and the bust variable.
4. [Where the picture goes](placing.md) > the insert modes, the invisible trace, leftovers, the redraw button, swipe and delete.
5. [Ship it with your card](card.md) > what `[Initmvuhelper]` carries, the state MVU Helper keeps, and checking your work.

## Any card, any image model

Image generation works on any card, MVU or not. 3 parts read the game state, so they need MVU: the explicit gate, the on-screen list, and the memory of what each person wore last.

The image model is whatever SillyTavern's Image Generation is set to. The built-in contract is written for Anima, Krea 2 and Qwen-Image: short comma-separated phrases, subject first.

## The parts

| Part | What it is | Where it lives |
| --- | --- | --- |
| `<pic>` | one picture: who, what they wear, the camera, the composition | the reply |
| the contract | the instruction that teaches the AI the tag | the Image tab per card, or the card's `[Initmvuhelper]` |
| the fixed rules | `<outfit_rules>`, `<picture_count>`, `<camera>`, `<explicit_rules>` | MVU Helper's code, the same on every install |
| `<scene_roster>` | who the game state says is on screen | the prompt, at Position and Depth |
| a look (DNA) | one person's `[Body]`, outfits and `[Bust]` | the card's lorebook |
| the prefix preset | quality and style tags | your PC's settings, picked per card |
| the trace | the tag, kept invisibly where it stood | the reply, in `data-rawtag` |
| `worn_outfit` | what each person wore in their last picture | `stat_data.mvuhelper.worn_outfit` |
| `/sd` | the drawing | SillyTavern's Image Generation |

## One picture, start to finish

Take ArtificKoi on Inline Replace Mode, 1 picture per reply. You type: "I sit down next to Mitsuki on the rooftop bench."

### 1. The prompt carries the rules

When SillyTavern builds the prompt, MVU Helper puts one system message at the very top: the contract, then `<outfit_rules>`, `<picture_count>` and `<camera>`.

There's no intimate scene, so the card's latch `PendingState.IntimacyActive` reads `false`, and `<explicit_rules>` stays out. `<scene_roster>` lists who's on screen, at the end of the prompt.

### 2. The AI writes the tag

Right under the sentence the picture belongs to:

```
Mitsuki scoots over to make room for you, laughing.
<pic char="Mitsuki" outfit="school-uniform" camera="eye-level" prompt="1girl, 1boy, sitting side by side on a bench, Mitsuki leaning toward the main character, laughing, school rooftop, noon, bright sunlight" mainchar="school-uniform">
```

It wrote no hair, no eyes and no clothes. Only the shot.

### 3. Drawing starts mid-stream

Streaming pre-generation sees the complete tag while the AI is still writing. Mitsuki's look is on file, in the outfit the tag names, so the job goes into the queue right away.

### 4. MVU Helper builds the image prompt

When the job runs, the prompt is put together:

```
masterpiece, best quality, …, very aesthetic, eye level, 1girl, 1boy, sitting side by side on a bench, Mitsuki leaning toward the main character, laughing, school rooftop, noon, bright sunlight. The person in the frame is Mitsuki: [Mitsuki] slim, adult hourglass figure, …, (plum-purple hair:1.3), …, brown academy uniform, cream short-sleeve sailor blouse, … [/Mitsuki] The main character in the frame is [main character] adult male, short dark hair, lean athletic build, brown academy uniform, cream short-sleeve sailor shirt, … [/main character]
```

The prefix comes first, then the camera's words, then the composition, then each look wrapped in its owner's name. The main character always closes it.

### 5. `/sd` draws it

At the card's Image type, landscape, so 1152 × 768. Mitsuki's look carries `[Bust] 1.7` and nobody else in the picture has one, so `bust_strength` is set to 1.7 right before the call.

### 6. The picture takes the tag's place

The reply finishes, and the draw pass waits on the same job instead of starting a second one. The picture replaces the tag. The tag itself stays in the picture's wrap, escaped, in `data-rawtag`.

### 7. The state remembers what they wore

At the end of the reply, MVU Helper writes `stat_data.mvuhelper.worn_outfit`: Mitsuki in `school-uniform`, the main character in `school-uniform`, both stamped with this message. Next picture, `same-as-last-picture` draws them in it.

## The settings behind it

Image Insert Type decides 2 things at once: whether the AI is sent the contract, and whether anything is drawn.

| Insert Type | Contract sent | Drawn |
| --- | --- | --- |
| Disable | no | no |
| Tags only | yes | no |
| Insert In Current Message, Create New Message, Inline Replace Mode | yes | yes |

On Disable a `<pic>` in the reply isn't MVU Helper's at all, so it's neither drawn nor touched.

Every field of the Image Generation tab is explained for players on [Auto Image Generation](README.md). These pages are about what's underneath.

Basically, the AI writes the shot, MVU Helper builds the prompt and places the picture, and `/sd` does the drawing.

[Back to Auto Image Generation](README.md) · [Back to index](../../README.md)
