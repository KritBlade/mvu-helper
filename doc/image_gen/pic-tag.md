# The `<pic>` tag

> This page applies to any card. ArtificKoi shows up as a real example, not as a rule.

One `<pic>` is one picture. The AI writes it on its own line, right under the one sentence it illustrates. Never bunched at the end of the reply.

This is the shape the contract teaches:

```
<pic char="CharKey" outfit="CharOutfit" camera="Camera" prompt="[Composition] your text" mainchar="UserOutfit">
```

## The attributes

| Attribute | What it says |
| --- | --- |
| `char=` | the first person drawn, by name |
| `outfit=` | what that person wears in this shot |
| `char2=` / `outfit2=`, `char3=` / `outfit3=` … | each other person, one slot each |
| `camera=` | where the camera stands, one of 7 choices |
| `prompt=` | the composition: the scene, and what each person does |
| `mainchar=` | the main character: an outfit when they're in the picture, `not-in-picture` when not |

Attributes come in any order, every value in double quotes. Slots are read in number order, so `char2=` is always the second person, wherever it stands in the tag.

`mainchar=` is written last, after `prompt=`, on purpose. By then the AI has already written the count tag in the composition, like `1girl, 1boy`, and that count is what decides whether the main character is in the shot.

A tag with no `char=` is scenery: a place with nobody named in it.

A `type=` on the tag is ignored. Every picture is drawn at the card's Image type.

## The composition is the shot, never the look

The AI writes the scene and what each person DOES. It writes zero appearance: no hair, no eyes, no skin, no body or chest size, no species features, no outfit.

That's because every look is attached by MVU Helper. An appearance word the AI writes anyway is a second copy that fights the real one. "red hair" next to Mitsuki's stored plum-purple, and the image model paints some of both.

A state of the clothes is fine, and it belongs here: pushed up, unbuttoned, torn, soaked. That's true for this one picture only, and no stored look can know it.

The contract asks for this order, subject first:

1. **The count tag:** `1girl`, `2girls`, `1girl, 1boy`. The main character counts whenever any part of them is in the frame. `nsfw` for a sexual or nude beat, `explicit` for penetration.
2. **The focal person:** pose, action, expression.
3. **Contact, as geometry:** where each body part is, against or inside what. "her hand flat on his chest", never "she touches him". A verb like "kiss" doesn't render, "lips pressed together" does.
4. **The scene:** place, time, lighting, 1 or 2 objects.
5. **The camera:** `camera=` on the tag, plus a framing like "upper body" when it helps.

25 to 60 words, short comma-separated phrases, lowercase, no underscores. Never a negation, because "no glasses" draws glasses. Never weighted brackets like `(tag:1.2)`, those live only in the looks.

### The cleanup

When everyone in the shot has a look, MVU Helper drops fixed appearance words the AI wrote anyway, one comma-separated phrase at a time:

- a colour on hair or eyes: "purple hair", "green eyes",
- a size: "C cup", "large breasts",
- a build word: hourglass, voluptuous, busty, petite, curvaceous.

Everything else stays: plain mentions of hair ("his hand in her hair"), states ("wet hair", "flushed skin"), species features and every garment. Each dropped phrase is named in the console.

When someone in the shot has no look, the composition is left alone. It may be the only description that person gets. And a composition that would lose every phrase is kept whole.

## Names

`char=` copies the name the way the story spells it, character for character, in the story's own script. 美月 stays 美月, never "Mitsuki". The same spelling every time.

`char=` is always a name, never a role. "the guard" or "the old man" is forbidden. An unnamed person stays in the composition as scenery, like "robed mage standing behind them".

Whoever acts or speaks in the sentence right above the tag is the one in `char=`.

The same name in 2 slots is drawn once, and the console says so. A slot holding an outfit word instead of a name, like `char="default"`, gets no look, and that's warned too.

## The camera

Every tag carries `camera=`, written exactly as one of these:

| `camera=` | Words added to the prompt | What it does |
| --- | --- | --- |
| `eye-level` | eye level | neutral |
| `from-below` | from below | low angle, the subject looks powerful |
| `from-above` | from above | high angle, the subject looks vulnerable |
| `dutch-angle` | dutch angle | tilted horizon, tension |
| `close-up` | close-up | a face, a touch |
| `wide-shot` | full body shot, camera pulled back, head-to-toe framing | the place, the distance between people |
| `pov` | pov | the main character's eyes |

The words go at the START of the composition. Image models settle the framing from the opening words. A distance at the end, like "close-up", was ignored in testing, while an angle held wherever it stood.

Words the composition already has aren't added twice. Case, spaces and underscores don't matter: `Eye Level` and `eye_level` both read as `eye-level`.

A missing or unknown `camera=` is warned, and the picture keeps whatever camera words the composition already has.

The story is written in first person, the pictures aren't. Without this rule, an AI puts the camera in the main character's eyes on every beat, and the main character is never drawn. So pov is one choice among 7, and the contract says never to use the same camera twice in a row.

## Outfits

Every slot names what that person wears in this shot:

| `outfit=` | Draws them in |
| --- | --- |
| an outfit on file, like `school-uniform` | those stored clothes |
| `default` | their plain `[Clothes]` |
| `same-as-last-picture` | what they wore in their last picture, from `worn_outfit` |
| `newclothes` | clothes none of the above are, because the story just changed them. The clothes are written down in the same reply |
| `undressed` | no clothes. It outranks every other value, and the composition then says how |

How a look and its outfits are written belongs with the looks, on their own page.

Values are written in English, whatever language the story is in. The code reads them word for word, and no code can recognise every language's word for "undressed". Names are the opposite: they stay in the story's script.

`outfit=` names WHICH clothes, never how they sit right now. Pushed up or soaked is still the same outfit, and the composition says it.

A slot with no `outfit=`, or with an outfit that person doesn't have, is drawn in what `worn_outfit` holds for them, else with no clothes. The console names the slip.

## The main character

The main character, `{{user}}`, never takes a `char=` slot. They have `mainchar=` on every single tag:

- an outfit (`default`, one of their outfits, `same-as-last-picture` or `undressed`) when ANY part of them is in the frame,
- `not-in-picture` when no part of them is, and on every pov shot, because the camera is their eyes.

A body part brings its owner. The image model draws a whole body for every body part it's shown, and dresses a body with no look in the looks it was given. So "his hand on her shoulder" puts him in the shot, with his outfit in `mainchar=` and his place in the count tag.

The one exception is pov hands. In a pov shot, the main character's own hands reaching into the frame are written "pov hands" with what they do. The image model draws them coming from the camera with no body behind them, so they need no look.

In the composition, the main character is always "the main character". Never the persona's name, never "user". That's the same name their look is wrapped in, `[main character] … [/main character]`, so the image model can match the two. I measured it on Krea 2, with 2 girls and him on a bench and 12 seeds a variant. All 3 came out in 11 or 12 of 12, against 8 of 12 before.

What's warned:

- a tag with no `mainchar=`. The main character isn't drawn.
- a composition that names the main character outside a pov shot, on a tag whose `mainchar=` says `not-in-picture`. No look is attached, so the image model builds that body from the looks it was given.
- a pov shot with an outfit in `mainchar=`.

## How a tag is found

The built-in regex, on the Image tab's **Regex** field:

```
/<pic\b(?:"[^"]*"|[^"<])*?\bprompt\s*=\s*"([^"]*)"[^<>]*>/gi
```

Group 1 is the composition. Each other attribute is read off the matched tag by name, so `char` never matches inside `mainchar`, and `outfit` never matches `outfit2`.

Only `<pic>` is ever looked for, never `<img>`. An `<img>` is real HTML: a broken one corrupts the story on screen, and a real one written by a preset or another extension isn't MVU Helper's to touch.

The regex can't run across into another element, because `[^"<]` stops at the first `<`. A custom regex can, so any match over 1500 characters, or holding `auto-img` or `</`, is ignored with a warning to reset the regex.

A tag with an empty `prompt=` has nothing to draw. It's still taken out of the reply like any other tag, see [Where the picture goes](placing.md).

Basically, the AI writes who, what they wear, where the camera is and what happens. MVU Helper does the rest from that.

[Back to How Auto Image Generation works](technical.md) · [Back to index](../../README.md)
