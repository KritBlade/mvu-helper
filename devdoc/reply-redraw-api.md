# Editing a finished reply from another extension

**Audience: authors of SillyTavern extensions and TavernHelper scripts that change an AI reply after it is
finished**, for example to insert their own tag, a translation, or a different layout. mvu-helper's own code
follows `devdoc/editing-a-finished-reply.md` instead.

mvu-helper edits every finished reply several times per turn (the engine's text, pictures, the stat box, the
POST receipt) and writes it **once**, when the turn ends. This API lets your edit join that one write.

---

## 1. Why not write `.mes` yourself

The usual way to edit a reply is to read `chat[id].mes`, do some work, and write the text back. While a turn
runs, that goes wrong in two ways:

- **It erases mvu-helper's edits.** Every edit mvu-helper makes lands in `mes` at once. A copy you read before
  an `await` (your own model call, a fetch) does not have the edits made during that await, and writing it
  back removes them: a picture, the stat box, the engine's text.
- **Every write is one more refresh.** A write re-renders the reply, rebuilds every frame mounted in it,
  announces `MESSAGE_UPDATED` and saves the whole chat. Each extension that writes on its own adds one.

With the API, mvu-helper hands you the latest text at your turn in a queue, takes your edited text back in
the same step, and writes the reply once.

## 2. Two ways in

| You want to | Use | Event |
|---|---|---|
| add something once your own work for this reply is done | the **hand-in** | `mvu_helper_reply_edit` |
| change every write of a reply (a layout, a display format) | the **last call** | `mvu_helper_reply_last_call` |

Both take the same edit object (§3), and both join the same queue.

### The hand-in

Name the reply when you start, and hand the edit in when your work is done:

```js
const request = { chat_id, message_id, swipe_id };
await eventSource.emit('mvu_helper_reply_edit', request);   // TavernHelper: await eventEmit(...)
// ... your own work ...
const outcome = request.handIn(edit);
```

mvu-helper checks the request when you emit it and puts `handIn` on the same object. From then on it follows
that reply itself, so `handIn` still finds it after a message above it is deleted, and refuses it when the
reply was regenerated, swiped to another take, or the chat changed.

`handIn(edit)` returns:

- `'held'` — the turn is still running for this reply. Your edit joins the turn's one write.
- `'written'` — the turn's write has already happened. Your edit is written now, in a write of its own.
- `'refused'` — the console says why (§6).

If `request.handIn` is not a function after the emit, mvu-helper is not installed: write the reply yourself.

Hand in again for the same reply and the newer edit replaces the older one, as long as the turn is still
holding it.

### The last call

Before every write of a reply, mvu-helper emits the last call. A listener that wants to edit the reply calls
`edit(...)` before it returns:

```js
eventSource.on('mvu_helper_reply_last_call', ({ chat_id, message_id, swipe_id, edit }) => {
    edit({ by: 'my-extension', stage: 'presentation', apply: (text) => reshape(text) });
});
```

`edit` returns `'queued'` or `'refused'`. A call after your listener returned is refused.

The last call comes before **every** mvu-helper write of a reply: the turn's write, a picture that lands
after it, a picture regenerate, a hand-in written on its own. So your edit must change nothing when it runs on
text it has already edited.

## 3. The edit

```js
{
    by: 'my-extension',                        // your extension's name: in the log line and every warning
    stage: 'content',                          // 'content' or 'presentation' (§4)
    prepare: async (text, { signal }) => {},   // optional: slow side work before the write (§5)
    apply: (text) => edited,                   // synchronous: the latest text in, your edited text out
}
```

The rules:

- **`apply` is synchronous.** It gets the latest text and returns the edited text, or the same text when there
  is nothing to do. A returned Promise is refused, and so is anything that is not a string.
- **Edit by search, never from a copy.** `apply` gets the text after every earlier editor and every
  mvu-helper edit so far. Find your place in it again (`text.replace(...)`, `text.indexOf(...)`); never return
  a text you saved earlier.
- **Running it on its own output changes nothing.** Check for your own marker before adding it.
- **Never render, save or emit** from `prepare` or `apply`. The write that follows does all three.
- **`prepare` never changes the reply.** It gets a copy of the text as mvu-helper left it (before any other
  extension's edit), may take its time, and stops when `signal` aborts.
- **Leave mvu-helper's and MVU's tags as they are**: `<pic>`, `<cast>`, `<UpdateVariable>`, `<LeadText>`,
  `<EndText>` and the blocks around them. They are read back from the text after the write (a picture's
  regenerate reads its `<pic>`, a continue parses the whole reply again, and a later resolve refreshes the
  `<LeadText>` and `<EndText>` blocks where they stand), so never add, change or remove one.

## 4. The order

The queue runs in a fixed order, the same on every install:

1. `content` edits: they change what the reply says (a tag, a block, a translation);
2. `presentation` edits: they reshape the text for one display, so they come last and see every word.

Within a stage, editors run in the order of their `by` names (code-point order). Extension load order is never
used. Two editors of one stage must not depend on each other; if they do, one of them is a `presentation` edit.

Each `apply` gets the text the editor before it returned:

```text
text0 = the reply, with every mvu-helper edit of this turn
text1 = a-extension.apply(text0)        content
text2 = b-extension.apply(text1)        content
text3 = galgame-companion.apply(text2)  presentation
then one write of text3
```

One edit per extension per write: a second edit with the same `by` in one write is refused.

## 5. The 5 s window

From the moment the last call starts, the whole queue has **5 seconds**: your listener offering its edit, and
then every editor's `prepare`, all started at once. An editor whose `prepare` is still running at 5 s is cut
off: its `signal` aborts, its edit is left out of this write, and the console names it. One whose `prepare`
throws is left out the same way. The others' `apply` still run, in order.

So a reply never waits more than 5 s for extensions, however many are installed, and one slow extension
never takes time from another.

Your extension cannot make the turn's write wait for it. The turn's write happens when mvu-helper's own work
is done: its POST pass, and every edit its own stages are still making (pictures included). A hand-in that
arrives after that is written on its own, as one more refresh.

## 6. Refusals and what they mean

Every refusal is a console warning from `[mvu-helper] [reply-redraw]` naming your `by`:

| The warning says | What to fix |
|---|---|
| `it names chat "…", but chat "…" is open` / `there is no message N` / `message N is the user's` | the request's `chat_id` or `message_id` |
| `swipe S of message N is not the one showing` | the request's `swipe_id`: the reply's current `swipe_id` |
| `the reply is gone (regenerated or deleted)` / `another swipe of it is showing` / `another chat is open now` | nothing: the reply your work was for is not on screen any more |
| `its stage "…" is neither "content" nor "presentation"`, `it has no apply(text) function`, `it has no \`by\` name` | the edit object (§3) |
| `apply returned a Promise` / `apply returned undefined, not the text` / `apply threw` | `apply` (§3) |
| `it is the second edit from this extension in one write` | combine your edits into one |
| `prepare was still running 5s after the last call began — cut off` | move the slow work earlier: a hand-in once it is done |

## 7. Two worked examples

### A TavernHelper script that adds a block once its own call is done (hand-in)

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

In a SillyTavern extension, read the chat and its id from `SillyTavern.getContext()` and emit with
`eventSource.emit` instead.

### An extension that reshapes every write (last call)

```js
eventSource.on('mvu_helper_reply_last_call', ({ edit }) => {
    edit({
        by: 'my-ruby-text',
        stage: 'presentation',
        apply: (text) => text.replace(/\{([^|{}]+)\|([^|{}]+)\}/g, '<ruby>$1<rt>$2</rt></ruby>'),
    });
});
```

After one run no `{word|reading}` is left, so a second run changes nothing.

galgame-companion is a last-call editor too: its `prepare` files the backdrops its shaped text names, and its
`apply` shapes the reply into galgame's beats.

## 8. Reading mvu-helper's log line for a write

Turn on mvu-helper's `pipeline` debug domain. Each write that ran an extension edit prints one line naming
every editor in queue order and what became of it:

```text
[mvu-helper] [reply-redraw] msg 46: extension edits at the turn's end — my-summary (content) changed +212 · galgame-companion (presentation) changed +96
[mvu-helper] [reply-redraw] msg 46: one write at the turn's end for logic-engine RES reply text, imagegen draw pass, POST receipt, hand-in from my-summary
```

An editor's entry reads `changed +N` (characters added, `-N` removed), `unchanged`, `cut off at the window's
end`, `dropped: prepare threw`, or `refused: <why>`. A hand-in written after the turn reads `on its own` in
place of `at the turn's end`.
