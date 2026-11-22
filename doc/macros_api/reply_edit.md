# Editing a finished reply from your extension

> This page is for people who write SillyTavern extensions or Tavern Helper scripts. A card never needs it.

MVU Helper edits every reply several times after the AI finishes it, and writes it to the chat ONCE, at the end of the turn. If your extension changes a finished reply too, this API puts your edit in that same one write.

## What's on this page

1. [Why not write `.mes` yourself](#why-not-write-mes-yourself) > the 2 things that go wrong.
2. [The 2 ways in](#the-2-ways-in) > the hand-in and the last call.
3. [The edit](#the-edit) > the object both of them take, and its rules.
4. [The order](#the-order) > who edits first.
5. [The 5 second limit](#the-5-second-limit) > how long a reply waits for extensions.
6. [When an edit is refused](#when-an-edit-is-refused) > every warning, and what to fix.
7. [2 examples](#2-examples) > a Tavern Helper script and an extension.
8. [Checking your work](#checking-your-work) > the log line for each write.

## Why not write `.mes` yourself

A finished reply gets edited a LOT in one turn. The engine's text, the pictures, the stat box, the POST receipt. Each edit lands in `.mes` the moment it's made, so anything that reads the text sees it right away. Only the redraw and the save wait for the end of the turn.

The usual way to edit a reply is to read `chat[id].mes`, do your work, and write the text back. While a turn is running, that goes wrong in 2 ways.

**It erases MVU Helper's edits.** Say your extension reads the reply, then waits 8 seconds for its own model call. During those 8 seconds a picture lands in the reply. Your copy doesn't have the picture, so writing your copy back deletes it.

It's like photocopying a page of a shared notebook, writing on your copy for an hour, and then putting your copy back in the binder. Whatever the others wrote on the real page during that hour is gone.

**Every write is one more refresh.** A write redraws the reply, rebuilds every frame inside it like the status menu, fires `MESSAGE_UPDATED` and saves the whole chat. 3 extensions that each write on their own make the reply flash 3 more times.

So with the API, MVU Helper hands your edit the latest text, takes your edited text back in the same step, and writes the reply once for everybody.

## The 2 ways in

Think of the turn's write as a bus that leaves once. You can hand your bag to the driver the moment it's packed, or wait for the driver's "last call" right before the doors close. Either way, your bag rides the same bus.

| You want to | Use | Event |
| --- | --- | --- |
| add something once your own work for this reply is done | the hand-in | `mvu_helper_reply_edit` |
| change every write of a reply, like a layout or a display format | the last call | `mvu_helper_reply_last_call` |

Both take the same edit object, see [The edit](#the-edit), and both go into the same queue.

### The hand-in

Name the reply when you start your work, and hand the edit in when your work is done:

```js
const request = { chat_id, message_id, swipe_id };
await eventSource.emit('mvu_helper_reply_edit', request);   // Tavern Helper: await eventEmit(...)
// ... your own work ...
const outcome = request.handIn(edit);
```

MVU Helper checks the request when you emit it, and puts `handIn` on that same object. From then on it follows that reply itself. So `handIn` still finds the reply when a message above it gets deleted, and refuses when the reply was regenerated, swiped to another take, or the chat changed.

`handIn(edit)` gives back one of 3 words:

- `'held'`: the turn is still running for this reply, so your edit goes out with the turn's one write.
- `'written'`: the turn's write already happened, so your edit is written now, in a write of its own.
- `'refused'`: the console says why, see [When an edit is refused](#when-an-edit-is-refused).

If `request.handIn` isn't a function after the emit, MVU Helper isn't installed. Write the reply yourself.

Hand in again for the same reply while the turn still holds it, and the newer edit replaces the older one.

### The last call

Right before every write of a reply's text, MVU Helper fires the last call. A listener that wants to edit the reply calls `edit(...)` before it returns:

```js
eventSource.on('mvu_helper_reply_last_call', ({ chat_id, message_id, swipe_id, edit }) => {
    edit({ by: 'my-extension', stage: 'presentation', apply: (text) => reshape(text) });
});
```

`edit` gives back `'queued'` or `'refused'`. Once the last call is over, every `edit` is refused, so call it before your listener returns.

The last call comes before EVERY text write of a reply. The turn's write, a picture that lands after it, a picture redraw, a hand-in written on its own. So your edit will run on text it already edited, and that second run must change nothing.

## The edit

```js
{
    by: 'my-extension',                        // your extension's name, in the log line and every warning
    stage: 'content',                          // 'content' or 'presentation', see The order
    prepare: async (text, { signal }) => {},   // optional: slow side work before the write
    apply: (text) => edited,                   // synchronous: the latest text in, your edited text out
}
```

The rules:

- **`apply` is synchronous.** It gets the latest text and returns the edited text, or the same text when there's nothing to do. A Promise is refused, and so is anything that isn't a string.
- **Edit by search, never from a copy.** `apply` gets the text after every editor before it and every MVU Helper edit so far. Find your spot in it again, with `text.replace(...)` or `text.indexOf(...)`. Never return a text you saved earlier. That's the photocopy all over again.
- **Running it on its own output changes nothing.** Check for your own marker before you add it.
- **Never redraw, save or emit** from `prepare` or `apply`. The write that comes after does all 3.
- **`prepare` never changes the reply.** It gets the text as MVU Helper left it, before any other extension's edit. It can take its time, and it stops when `signal` aborts.
- **Leave MVU Helper's and MVU's tags alone**: `<pic>`, `<cast>`, `<UpdateVariable>`, `<LeadText>`, `<EndText>` and the blocks around them. They get read back from the text after the write. A picture's redraw reads its `<pic>`, a continue parses the whole reply again, and the next resolve refreshes `<LeadText>` and `<EndText>` right where they stand. So never add, change or remove one.

## The order

The queue runs in a fixed order, the same on every install:

1. `content` edits go first. They change what the reply says, like a tag, a block or a translation.
2. `presentation` edits go last. They reshape the text for one display, so they have to see every single word.

Inside a stage, editors run in the order of their `by` names, by code point. Extension load order is never used, because it's different on every install. Two editors of one stage must not depend on each other. If they do, one of them is really a `presentation` edit.

Each `apply` gets the text the editor before it returned:

```text
text0 = the reply, with every MVU Helper edit of this turn
text1 = a-extension.apply(text0)        content
text2 = b-extension.apply(text1)        content
text3 = galgame-companion.apply(text2)  presentation
then one write of text3
```

One edit per extension per write. A second edit with the same `by` in the same write is refused, so combine them into one.

## The 5 second limit

From the moment the last call starts, the whole queue gets **5 seconds**. That covers your listener offering its edit, and then every editor's `prepare`, all started at the same time.

A `prepare` that's still running at 5 seconds is cut off. Its `signal` aborts, its edit stays out of this write, and the console names it. A `prepare` that throws stays out the same way. Everybody else's `apply` still runs, in order.

So a reply never waits more than 5 seconds for extensions, no matter how many are installed. And one slow extension never eats another one's time.

Your extension can't make the turn's write wait for it. The write happens when MVU Helper's own work is done: its POST pass, and every edit its own parts are still making, pictures included. A hand-in that shows up after that is written on its own, as one more refresh.

## When an edit is refused

Every refusal is a console warning from `[mvu-helper] [reply-redraw]` that names your `by`:

| The warning says | What to fix |
| --- | --- |
| `it names chat "…", but chat "…" is open` / `message_id N is not a message index` / `there is no message N` / `message N is the user's, not a reply` | the request's `chat_id` or `message_id` |
| `swipe S of message N is not the one showing` | the request's `swipe_id`: use the reply's current `swipe_id` |
| `the reply is gone (regenerated or deleted)` / `another swipe of it is showing` / `another chat is open now` | nothing. The reply your work was for isn't on screen anymore |
| ``it has no `by` name`` / `its stage "…" is neither "content" nor "presentation"` / `it has no apply(text) function` / `its prepare is not a function` | the edit object, see [The edit](#the-edit) |
| `apply returned a Promise` / `apply returned undefined, not the text` / `apply threw` | your `apply` |
| `it is the second edit from this extension in one write` | combine your edits into one |
| `the last call had already ended` | call `edit` before your listener returns |
| `prepare was still running 5s after the last call began` | do the slow work earlier, and hand the edit in once it's done |

## 2 examples

### A Tavern Helper script that adds a block once its own call is done

This one uses the hand-in:

```js
eventOn(tavern_events.MESSAGE_RECEIVED, async (messageId) => {
    const message = SillyTavern.chat[messageId];
    if (!message || message.is_user) return;
    const request = { chat_id: SillyTavern.chatId, message_id: messageId, swipe_id: message.swipe_id ?? 0 };
    await eventEmit('mvu_helper_reply_edit', request);
    const summary = await summarize(message.mes);          // your own slow work
    const edit = {
        by: 'my-summary',
        stage: 'content',
        apply: (text) => (text.includes('<my_summary>') ? text : `${text}\n<my_summary>${summary}</my_summary>`),
    };
    if (typeof request.handIn === 'function') request.handIn(edit);
    else await setChatMessages([{ message_id: messageId, message: edit.apply(message.mes) }]);
});
```

Without MVU Helper, the script writes the reply itself with `setChatMessages`, so it works either way.

In a SillyTavern extension, read the chat and its id from `SillyTavern.getContext()`, and emit with `eventSource.emit` instead.

### An extension that reshapes every write

This one uses the last call:

```js
eventSource.on('mvu_helper_reply_last_call', ({ edit }) => {
    edit({
        by: 'my-ruby-text',
        stage: 'presentation',
        apply: (text) => text.replace(/\{([^|{}]+)\|([^|{}]+)\}/g, '<ruby>$1<rt>$2</rt></ruby>'),
    });
});
```

After one run there's no `{word|reading}` left, so a second run changes nothing.

My galgame-companion extension is a last-call editor too. Its `prepare` files the backdrops its shaped text names, and its `apply` shapes the reply into galgame's beats.

## Checking your work

Turn on the `pipeline` debug domain on the Main tab, or from code with `MvuHelper.settings.set('debug.pipeline', true)`. Every write that ran an extension's edit prints one line, with every editor in queue order and what happened to it:

```text
[mvu-helper] [reply-redraw] msg 46: extension edits at the turn's end — my-summary (content) changed +212 · galgame-companion (presentation) changed +96
[mvu-helper] [reply-redraw] msg 46: one write at the turn's end for logic-engine RES reply text, imagegen draw pass, POST receipt, hand-in from my-summary
```

An editor reads `changed +N` (characters added, `-N` removed), `unchanged`, `cut off at the window's end`, `dropped: prepare threw`, or `refused: <why>`. A hand-in written after the turn says `on its own` instead of `at the turn's end`.

Basically, find your spot by search, keep `apply` synchronous, and let MVU Helper do the one write.

[Back to Every macro and API call](technical.md) · [Back to index](../../README.md)
