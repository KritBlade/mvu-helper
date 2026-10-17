# Where the picture goes

> This page applies to any card. ArtificKoi shows up as a real example, not as a rule.

The draw pass runs once the reply is received. It waits a moment first, so the reply is on screen before anything is drawn into it.

It remembers WHICH message it's drawing for, and checks it's still the same message before a picture goes in. Swipe, regenerate or delete while a picture is drawing, and that picture is dropped. The file stays on disk, and the console says so.

Think of a waiter carrying a plate to table 5. If table 5 got up and left, the plate goes back to the kitchen. It doesn't go to whoever sits down there next.

## Inline Replace Mode

The picture takes the tag's exact place. The tag is swapped for a wrap:

```html
<span class="auto-img-wrap" data-rawtag="&lt;pic char=&quot;Mitsuki&quot; …&gt;">
  <img src="…" title="<the full prompt sent to /sd>" alt="generated image">
  <span class="auto-img-regen fa-solid fa-arrows-rotate" title="Regenerate image"></span>
</span>
```

- `data-rawtag` holds the original tag, escaped. The redraw button and the chat history read it back.
- `title` holds the full prompt, so hovering the picture shows exactly what `/sd` got.
- the last span is the redraw button.

The tag is found by searching for its text at that moment, never by a position saved earlier. While `/sd` is drawing, other passes edit the same message, MVU's write-back among them. A saved position would put the picture in the wrong place and eat that many characters of the story. If the tag is gone entirely, the picture isn't put anywhere, the error names it, and the file is kept.

SillyTavern's sanitizer renames classes in the chat to `custom-auto-img-wrap`, `custom-auto-img-regen` and so on. So style both names if your card styles the pictures.

## Insert In Current Message

The picture is attached to the reply as SillyTavern media, the way SillyTavern attaches any picture, with the full prompt as its title. The reply's text isn't touched, apart from Strip `<pic>` tag.

## Create New Message

`/sd` runs without quiet, so SillyTavern posts the picture as a message of its own, right after the reply. This mode is never pre-generated, see [From tag to `/sd`](drawing.md#when-drawing-starts).

## Tags only

Nothing is drawn. Each tag's composition is logged to the console, in the Image gen debug domain, and the tag is handled by Strip `<pic>` tag like in any other mode.

## Strip `<pic>` tag and the invisible trace

With Strip on, a tag that leaves the text doesn't vanish. It becomes an invisible trace in the exact same spot:

```html
<span class="auto-img-wrap" data-rawtag="&lt;pic …&gt;"><span class="auto-img-trace"></span></span>
```

That's what happens to a drawn tag in Insert In Current Message and Create New Message, and to every tag in Tags only. In Inline Replace Mode the picture's own wrap already carries the tag, so it needs no trace.

Every insert mode keeps the same record this way:

- **who was drawn in what clothes.** `worn_outfit` and the redraw button read it back.
- **the AI's own tags.** The outgoing chat history turns every wrap back into its tag, see [What the AI is sent](prompt.md#the-chat-history-pictures-go-back-to-tags).
- **a clean reply for galgame companion.** A trace is image markup with no picture in it, not a raw `<pic>`, so nothing waits on it.

With Strip off, the tag stays visible, for troubleshooting:

| Mode | Strip off |
| --- | --- |
| Insert In Current Message, Create New Message, Tags only | the raw tag stays in the reply |
| Inline Replace Mode | an escaped copy, `<code class="auto-img-pictag">`, shows under the picture |

A picture that failed in Insert In Current Message or Create New Message always keeps its raw tag, Strip or not. You can see something went wrong, and where.

## Leftovers in Inline Replace Mode

Some tags in Inline Replace Mode never get a picture: one over the cap, or one whose drawing failed. Those can't stay as raw `<pic>` markup either. galgame companion holds back its backdrop while a raw tag remains, so 4 tags over a cap of 2 would leave a blank stage.

| Strip | A leftover becomes |
| --- | --- |
| on | an invisible trace |
| off | an escaped visible copy, in an `auto-img-wrap` with an `auto-img-unrendered` marker |

Only the exact tags this pass found at its start are touched. The finished message is never scanned again, so nothing MVU Helper didn't detect itself is ever changed. That's the whole guarantee that it can't rewrite another extension's tag by mistake.

## The redraw button

Inline Replace Mode only. Clicking it draws that picture again, and swaps in the new one.

The prompt is rebuilt from `data-rawtag`, with every look as it is NOW. So when you fix a character's look, every old picture you redraw gets the fix. The bust number is worked out again too, and the size is the card's Image type, same as a first draw.

Only the clicked picture is swapped. It's found by its `data-rawtag` when that's unique in the message, else by its place among the message's pictures. When neither settles it, the swap is refused rather than guessed, and the new file stays on disk. A wrong swap would be silent, and you'd only find it when you scroll up.

A very old picture with no `data-rawtag` is redrawn from its `title`.

## Swipe, regenerate, chat switch and delete

| Event | What's cleared |
| --- | --- |
| swipe | the jobs still waiting in the queue, and the stream's pre-generation state |
| chat switch | everything: queue, finished jobs, pre-generation state |
| delete | everything. Messages are tracked by position, and a delete shifts every position after it |

On top of that, every picture checks its message is still the same one before it goes in, as at the top of this page.

## When something else erases a picture

After each render, MVU Helper checks that every picture it put in this turn is still in the reply. When another writer rewrote the reply from a copy taken before the picture landed, the picture turns back into a raw tag, or vanishes.

That's named in the console, once per picture, with the file's path. It's never repaired from here, because the defect is the other writer's, and quietly writing over it would hide it from whoever needs to fix it. MVU before v0.189.0 did exactly this, so check your MVU version first.

## Saving

When the text changed (a picture spliced in, a tag stripped, a leftover traced), the reply is redrawn and saved with the turn's other edits. A picture attached without touching the text, in Insert In Current Message or Create New Message, is saved too.

The toasts say how it went: "Generating 2 image(s)...", then "2 image(s) generated", or "Image generation produced no image" when none made it.

Basically, the picture goes exactly where its tag was, the tag stays behind invisibly as the record, and nothing ever lands in a message that changed underneath it.

[Back to How Auto Image Generation works](technical.md) · [Back to index](../../README.md)
