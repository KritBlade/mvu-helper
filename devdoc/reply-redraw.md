# The reply redraw — editing a finished reply (`msg.mes`, `msg.swipes`, `msg.extra`, `.mes_text`)

**Audience: anyone whose code changes a reply AFTER the model finished it.**

- **Part A** is for mvu-helper's own code (and a GameLogic Plugin): the one recipe, what each step of the write
  guards, and the rules for the four surfaces a reply lives on.
- **Part B** is the API other SillyTavern extensions and TavernHelper scripts use to join the same write, with the
  code behind it. The public page for those authors is `doc/macros_api/reply_edit.md` in the released repo.

Card authors want `devdoc/dev-helper.md` §1.6 instead: that one says *what* to write into a reply; this one says *how
to write it without breaking what is already mounted in it*.

A finished reply is not a private string. Four surfaces hold it, other extensions read it, and frames are mounted
inside it. Each rule below names what breaks without it.

The code: `src/features/reply-redraw/` (`reply-redraw.js` the host half, `reply-redraw-core.js` the pure half,
tested in `tests/reply-redraw-core.test.js`) and `src/sillytavern/reply-text-write.js` (the four-step write, tested
in `tests/reply-text-write-core.test.js`).

---

# Part A — mvu-helper's own edits

## TRACK1 — The one recipe: hand the edit to the reply redraw

Changing the visible text of message `mid`:

```js
import { redrawReply } from '../reply-redraw/index.js';

message.mes = nextText;
await redrawReply(message, mid, 'your writer's own name');
```

An edit outside the text (an image attached as media with `appendMediaToMessage`) changes nothing to
render but still has to persist: `await saveRedrawnReply(message, mid, label)`.

**One write per finished reply per turn.** The reply redraw
([features/reply-redraw](../src/features/reply-redraw/reply-redraw.js)) owns every write into a
finished reply:

- **While the reply's post-reply phase runs**, your edit's swipe mirror runs at once, and the render,
  the announcement and the save are owed. The reply's record opens in mvu-helper's first
  `MESSAGE_RECEIVED` listener (registered with `makeFirst`, extra-llm-calls.js `openTurnRecordFirst`), so
  every later listener on that event finds it open: MVU's parse and the stat box built at its end, the
  image pass, the look task's narrate capture. A stopped reply opens one too. The POST pass takes the record
  and closes it when it ends, which is the last mvu-helper step of every generated reply, POST calls or
  not. The phase's end refreshes the stat box from the turn's final state, waits for the edits still being
  made (below), then writes once for every edit, before the turn-phase signal says the turn is done.
  Once no LLM call is left before that write (POST's calls have returned, none runs, or the reply was
  stopped), the pass marks the record (`noteReplyRedrawEnding`). From then on, while no announced edit is
  still being made, the write is due: whatever would redraw something inside the reply only for the write to
  rebuild it asks `isReplyWriteDue(mid)` and waits with `dueReplyWriteEnded(mid)`, as the status menu's state
  push does.
- **An edit still being made when the phase ends is announced first**, or it misses the write:

  ```js
  import { announceReplyEdit } from '../reply-redraw/index.js';

  announceReplyEdit(message, mid, { label: 'your writer', work: promiseOfYourWork, allowanceMs: 60_000 });
  ```

  `work` settles when your stage is done, whether or not it edited; hand the edit over with `redrawReply`
  before that. The phase's write waits for every announced edit, and the record's deadline grows to the
  longest allowance announced. Announce in your listener's synchronous part, before its first `await`: the
  turn can end at any await. The image draw pass (one minute per picture, at most four per reply), the Tags-only
  strip, the parked pictures' drain and the narrate capture announce themselves, and so does the stat box built at
  MVU's parse. MVU parses in a `MESSAGE_RECEIVED` listener of its own, after the POST pass's, so the statbox
  announces the box when the reply arrives and settles it at `CHARACTER_MESSAGE_RENDERED`, which SillyTavern emits
  only after every `MESSAGE_RECEIVED` listener has returned. An edit made inside another listener of the reply's
  arrival can be announced the same way. When a POST call writes the pictures, they are placed and their drawing is
  announced at that call's capture (`POST_DONE_EVENT`), which comes before the POST pass ends, so the turn's write
  waits for them too (`plans/executed/picture-writer-route.md` D9).
- **The phase runs on a clock** (`postPhaseTimings`): each POST call in the longest chain gets one Call
  timeout of the phase's time. Halfway through each slot, a phase whose POST work is still running raises a
  `[POST]` warning and a "POST slow" toast; the warnings stop when POST's own work is done. At the deadline
  (the end of the last slot, or later when an announced allowance reaches further) the edits held so far
  are written at once, a line names the announced edits still running, and whatever comes later is
  written on its own.
- **Otherwise** (no phase holding edits for that take: a picture regenerate, an edit after the turn's
  write), the edit is written now, on its own.

Your edit lands in `mes` the moment you make it, so everything that reads the text (POST, MVU,
galgame-companion, harvest) reads it at once. Only the screen and the chat file wait for the turn's
end.

**Every text write gives other extensions their turn first.** Before it writes, the reply redraw emits the
last call (`mvu_helper_reply_last_call`) and applies the extensions' edits, handed in or offered there, as
one synchronous chain on the latest `mes`, inside a hard 5 s window (Part B). Your own edit is already in `mes`
by then, so the chain sees it.

The write is `commitReplyTextEdit`
([sillytavern/reply-text-write.js](../src/sillytavern/reply-text-write.js)), four steps:

```js
syncActiveSwipeText(message);                                  // both copies of the text move together
updateMessageBlock(mid, message);                              // rebuilds .mes_text — destroys mounted children
await eventSource.emit(event_types.MESSAGE_UPDATED, mid);      // the announcement that lets them come back
await getContext().saveChat();
```

**All four are attempted, independently.** Skipping any one has its own failure (TRACK2), and none of
them is any of the others' business: a re-render that throws must not cost the save, and
MESSAGE_UPDATED runs OTHER extensions' listeners — one of them throwing is not a reason to drop this
message. Each step is caught, and each failure is reported with the writer's label, the step, and
what that step's absence costs. A deferred edit runs the first step alone
(`{ render: false, save: false }`).

`label` is your writer's own name for itself. It lands in every line the write produces, and the
turn's write lists every writer it carries: `reply redraw (logic-engine RES reply text, imagegen draw
pass, POST receipt)`.

There is no second way to do this, and tests enforce it (tests/reply-text-write-core.test.js):
`updateMessageBlock`, `emit(MESSAGE_UPDATED)`, `saveChat()` and `syncActiveSwipeText` each have
exactly one caller, the write, and `commitReplyTextEdit` and `saveReplyChat` are called only by the
reply redraw.

Turn the `pipeline` debug domain on and every edit announces itself:

```text
[reply-redraw] msg 46: the turn's write waits for imagegen draw pass (up to 120s)
[reply-redraw] msg 46: logic-engine RES reply text is written at the turn's end
[reply-text-write] logic-engine RES reply text -> msg 46: swipe · not attempted: render announce save
[reply-redraw] msg 46: imagegen draw pass is written at the turn's end
[reply-redraw] msg 46: extension edits at the turn's end — galgame-companion (presentation) changed +96
[reply-redraw] msg 46: one write at the turn's end for logic-engine RES reply text, POST receipt, stat box, imagegen draw pass
[reply-text-write] reply redraw (logic-engine RES reply text, POST receipt, stat box, imagegen draw pass) -> msg 46: swipe render announce save
```

An edit no turn is holding reads `[reply-redraw] msg 46: imagegen draw pass is written on its own (no turn
is holding edits for this take)`, and the deadline's write reads `one write at its deadline for …`, after a
warning naming the announced edits still running.

**Do not edit at all when the turn has moved on.** Every writer fences before it edits: the turn
runner's `{generationEpoch, mid, swipe}` guard (`turnStillLive` in turn-runner.js), POST's turn fence
(`postTurnFenceHolds` in extra-llm-calls.js), or the identity check
`getContext().chat[mesId] === message` (imagegen's draw pass). Writing a resolved reply's text onto a
newer reply is the same corruption as writing its state. The turn's write fences again: it lands only
while the take its edits belong to (the same message object, showing the same swipe) is still showing,
and otherwise warns and writes nothing.

---

## TRACK2 — What each omission costs

| Omitted | What breaks |
|---|---|
| `swipes[swipe]` | The edit lives only in `mes`. ST restores `mes` from the swipes array on every swipe, so swiping away and back **brings back the pre-edit text**: the stripped `<pic>` tag, a reply without the engine's lead text, without the POST receipt. |
| `updateMessageBlock` | The chat still shows the old text until something else re-renders the message. |
| `MESSAGE_UPDATED` | The DOM rebuild is silent, so **nothing that was mounted inside the message comes back**. See §1. |
| `saveChat` | In-memory only. Gone on reload, and the next context build sends the un-edited text. |

---

## 1. `.mes_text` belongs to whoever mounted something in it

`updateMessageBlock(mid, message)` is not a patch. It replaces the whole of `.mes_text`:

```js
messageElement.find('.mes_text').html(messageFormatting(text, …));   // SillyTavern public/script.js
```

`.html()` discards every child node and every listener bound to one, and emits **nothing**. That
matters because `.mes_text` is shared ground:

- **A StatusMenu pack's menu.** The card's regex turns `<StatusPlaceHolderImpl/>` into a
  rendered-region container (`div.custom-mvu-helper-region`), and mvu-helper mounts the menu in its own
  contained iframe inside it (`devdoc/statusmenu-pack-format.md`). The mount sweep runs on
  `CHARACTER_MESSAGE_RENDERED`, `MESSAGE_UPDATED`, `MESSAGE_EDITED`, `MESSAGE_SWIPED` and
  `MORE_MESSAGES_LOADED` (statusmenu-pack/statusmenu-frame.js).
- **TavernHelper** mounts an `<iframe>` inside a `<div class="TH-render">` wrapper around any `<pre>`
  whose text contains `html>`, `<head>` or `<body`. It renders only ids it has not already rendered,
  and it clears its record of a message only on `CHARACTER_MESSAGE_RENDERED`, `USER_MESSAGE_RENDERED`,
  `MESSAGE_UPDATED`, `MESSAGE_SWIPED`, `MESSAGE_DELETED`, `MORE_MESSAGES_LOADED` or `chatLoaded`
  (JS-Slash-Runner `src/store/iframe_runtimes/message.ts`).
- **SillyTavern display regexes** re-run inside `messageFormatting`, so the rebuild puts back the
  regex output (the region container, a code block), never the mounted frame.
- **imagegen's own markup** (`.auto-img-wrap`, the regenerate button) survives only because its click
  handler is delegated on `document`, never bound to the element (image-gen.js, the regenerate handler).

Of the events that bring a frame back, `MESSAGE_UPDATED` is the only one an editor of a finished
reply can honestly emit. Without it, the frames in that reply stay gone until a chat reload, which
re-renders everything, so the symptom reads as an environment problem rather than a missing emit.
`MESSAGE_EDITED` is never emitted (a source gate in `tests/reply-text-write-core.test.js` holds it):
it is the event for a user's own edit, SillyTavern's Prompt Manager answers it with a whole-prompt
rebuild (about 0.6 s on a large card), and every listener the write needs also hears `MESSAGE_UPDATED`.

**Prefer the narrow write.** If you only need to attach media, call
`appendMediaToMessage(message, messageElement)` and leave `.mes_text` alone (image-gen.js's draw pass,
Insert Type Inline), then hand over the save with `saveRedrawnReply`. A full rebuild you did not need
is a mounted-child bug you did not need.

---

## 2. `msg.extra` — mutate in place, never replace

- **ST replaces `message.extra` while you await.** Finalizing the reply overwrites it with
  `{api, model, reasoning, …}`. Anything you put there before an `await` is gone. Re-establish it
  after every await; that is what `ensureImageExtra` (image-gen.js) exists for.
- **Never hand `extra` to `TavernHelper.setChatMessages`.** Passing an `extra` object writes it as
  *the* extra for the message and wipes every **other** swipe's extra. Mutate the live object in
  place instead.
- `extra.display_text` **outranks** `mes` in `updateMessageBlock`. If something set it, your `mes`
  edit will not be visible. Check before blaming the write.

---

## 3. `msg.mes` is read raw by three other things

Editing the text is never display-only:

| Reader | Reads | Breaks how |
|---|---|---|
| **MVU** | the raw `<UpdateVariable>` / `<JSONPatch>` blocks | Splicing a block in does **not** apply it — MVU listens to `MESSAGE_RECEIVED/SENT/DELETED/CHAT_CHANGED/GENERATION_STARTED`, not `MESSAGE_EDITED`/`MESSAGE_UPDATED`. Only `Mvu.parseMessage(block)` applies **and** fires `VARIABLE_UPDATE_ENDED`. Pass the block, never the whole `mes` — the whole message re-applies narrate's ops. (`devdoc/dev-helper.md` §1.6) |
| **galgame beat-shaper** | the raw text, hunting `<pic>` | Any leftover raw `<pic>` reads as "generation still in flight" and defers backdrop binding **forever**. That is why the draw pass's leftover sweep (`disposeLeftoverPicTags`) is unconditional, and why the debug branch *escapes* the tag rather than leaving it raw. |
| **reply-integrity** | the raw text, checking tag balance | It infers a killed stream from an unterminated tag open **plus** an unclosed block tag (`diagnoseTruncatedReply` in reply-integrity-core.js). Splicing unbalanced markup into a healthy reply manufactures a false truncation toast. Keep spliced blocks well-formed; self-closing marker tags cost nothing. |

**Anchor on content, never on an offset.** Every edit re-finds its anchor string when it edits
(`base.includes('</UpdateVariable>')`, `spliceTagIntoMessage(…, rawTag, …)`). Several stages edit
the same reply in one turn, so a stored index is stale the moment any of them lands. When the anchor
is gone, **report and leave the message intact**; never guess an offset (`spliceTagIntoMessage`
reports `spliced: false` and the draw pass logs the lost image).

**A block that goes above the menu goes above the reply's tail.** An engine's `endText` sits in
`<EndText>` … `</EndText>` directly above MVU's `<StatusPlaceHolderImpl/>`, and its `leadText` in
`<LeadText>` … `</LeadText>` at the top of the story, past any block of the model's own above it, inside the
story block the card names in its `[Initmvuhelper]` `leadText.storyEnvelope` (`gamelogic-pack-format.md` §4.2;
the turn runner writes both in its reply-text edit, `placeLeadAndEndText` in turn-runner-core.js). A writer that puts its block above the
menu calls `placeAboveFirstAnchor(text, block, REPLY_TAIL_ANCHORS)` (shared/reply-block-placement.js; the
anchors come from the logic-engine barrel): above the end text when the reply carries one, else above the
placeholder, else after the text. That keeps the end text the last block above the menu. POST's blocks and
the relay's receipt are placed this way. A reader that must not take the engine's text for the narrator's
strips it with `stripLeadAndEndText`, beside `stripStatBoxFromText` (POST's input, the reply-cast name scan).

---

## 4. Idempotence, because you will be re-fired

RES2 relays, POST re-flushes and swipe re-entry all re-run these paths on a message that already
carries the edit. Guard on the **content**, not on a flag (POST carries `<RES_Variable>` only when
`!base.includes('<RES_Variable>')`), and hand over only when the text actually changed
(`if (text === message.mes) return;`).

Outside a turn, an edit that re-applies on a re-fire is an extra DOM rebuild and an extra `saveChat`,
which is how `Timeout waiting for chat to save` gets produced.

---

## MVU1 — MVU writes the reply back after awaiting its own event

**MVU re-reads the reply after its listeners and writes the CURRENT text** (MagVarUpdate
`handleVariablesInMessage`, v0.189.0 — the versionless jsDelivr URL every install loads):

```js
await updateVariables(message_content, variables);              // emits VARIABLE_UPDATE_ENDED, awaits every listener
const before = getChatMessages(message_id).at(-1);              // re-read
const context = { variables, message_content: before.message };
await eventEmit(BEFORE_MESSAGE_UPDATE, context);                 // listeners awaited
const listenerEdited = context.message_content !== before.message;
const current = getChatMessages(message_id).at(-1).message;     // re-read again
let text = listenerEdited ? context.message_content : current;  // + <StatusPlaceHolderImpl/>, - <status_current_variable>
if (text !== current) await setChatMessages([{ message_id, message: text }], { refresh: 'none' });
```

An edit made while the event's listeners run — the engine's text replacements, the stat box — is
already in `current`, so MVU keeps it. That needs MVU v0.189.0 or later: older MVU wrote
`message_content` whatever it held, reverting those edits.

**Never edit `message_content`.** A listener that changes it makes MVU write the listener's copy
instead of the current text, so an edit made during the event is reverted in `mes` AND the active
swipe; MVU then shows a 10 s "message overwritten" toast when it can see that happened. mvu-helper's
one listener on this event (the own-state end-of-reply pass: the reply's character registry changes, imagegen's
worn-outfit store and its edits, then the streetcleaner) writes `variables.stat_data` only, never `message_content`.

**What MVU's re-read cannot cover:** a writer that rewrites the reply from an older copy without
going through MVU at all. The image lane NAMES that loss (`auditRenderedImagesAfterForeignWrites`,
on every `CHARACTER_MESSAGE_RENDERED`) and does not repair it (L7).

When POST applied its own block, the turn's write lands after that parse and the handler runs it
started (applyPostBlocks awaits them): the relay's nested emit walks this reply's listeners, and
rebuilding the reply under it destroys the frame whose listener the emit is awaiting.

## Verifying a change to Part A

`updateMessageBlock` lives behind a host import, so no unit test can reach it. Prove it in the live
tab instead; one generation is the whole check:

```js
// in the ST page, right after a reply's turn has ended
document.querySelectorAll('#chat .mes[mesid="N"] iframe').length   // the menu's frame (and any TavernHelper frame): must not be 0
```

Zero means a rebuild went unannounced. Then mutate to confirm the guard is real: remove the write's
`MESSAGE_UPDATED` emit, regenerate, watch the count drop to 0, restore it, watch it return. A reload
heals the symptom, so **check before reloading** or you will prove nothing.

With the `pipeline` domain on, a turn shows exactly one `-> msg N: swipe render announce save` line
for its reply, plus one for a picture still drawing at the deadline.

---

# Part B — other extensions' edits (the reply redraw API)

**Audience: authors of SillyTavern extensions and TavernHelper scripts that change an AI reply after it is
finished**, for example to insert their own tag, a translation, or a different layout, and anyone changing the
code behind it. The event names and the edit object's shape are a released contract: outside extensions
(galgame-companion among them) depend on them, so a change to either is a released-API change.

mvu-helper edits every finished reply several times per turn (the engine's text, pictures, the stat box, the
POST receipt) and writes it **once**, when the turn ends (Part A). This API lets another extension's edit join
that one write.

## API1 — Why not write `.mes` yourself

The usual way to edit a reply is to read `chat[id].mes`, do some work, and write the text back. While a turn
runs, that goes wrong in two ways:

- **It erases mvu-helper's edits.** Every edit mvu-helper makes lands in `mes` at once. A copy you read before
  an `await` (your own model call, a fetch) does not have the edits made during that await, and writing it
  back removes them: a picture, the stat box, the engine's text.
- **Every write is one more refresh.** A write re-renders the reply, rebuilds every frame mounted in it,
  announces `MESSAGE_UPDATED` and saves the whole chat. Each extension that writes on its own adds one.

With the API, mvu-helper hands you the latest text at your turn in a queue, takes your edited text back in
the same step, and writes the reply once.

## API2 — Two ways in

| You want to | Use | Event |
|---|---|---|
| add something once your own work for this reply is done | the **hand-in** | `mvu_helper_reply_edit` |
| change every write of a reply (a layout, a display format) | the **last call** | `mvu_helper_reply_last_call` |

Both take the same edit object (API3), and both join the same queue.

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
- `'refused'` — the console says why (API6).

If `request.handIn` is not a function after the emit, mvu-helper is not installed: write the reply yourself.
A request refused at the emit still gets a `handIn`, one that refuses every edit, so the check above tells
"not installed" from "refused".

Hand in again for the same reply and the newer edit replaces the older one, as long as the turn is still
holding it.

### The last call

Before every text write of a reply, mvu-helper emits the last call. A listener that wants to edit the reply
calls `edit(...)` before it returns:

```js
eventSource.on('mvu_helper_reply_last_call', ({ chat_id, message_id, swipe_id, edit }) => {
    edit({ by: 'my-extension', stage: 'presentation', apply: (text) => reshape(text) });
});
```

`edit` returns `'queued'` or `'refused'`. Once the last call has ended (the emit has settled, or its 5 s window
has run out), every `edit` is refused, so a listener offers its edit before it returns.

The last call comes before **every** text write of a reply: the turn's write, a picture that lands after it, a
picture regenerate, a hand-in written on its own. A write that only saves (a picture attached as media, no text
changed) emits no last call. So your edit must change nothing when it runs on text it has already edited.

## API3 — The edit

```js
{
    by: 'my-extension',                        // your extension's name: in the log line and every warning
    stage: 'content',                          // 'content' or 'presentation' (API4)
    prepare: async (text, { signal }) => {},   // optional: slow side work before the write (API5)
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

## API4 — The order

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

One edit per extension per write: a second edit with the same `by` in one write is refused. The write's hand-ins
queue before its last-call offers, so when one extension both handed in and offered at the last call, the offer
is the one refused.

## API5 — The 5 s window

From the moment the last call starts, the whole queue has **5 seconds**: your listener offering its edit, and
then every editor's `prepare`, all started at once. An editor whose `prepare` is still running at 5 s is cut
off: its `signal` aborts, its edit is left out of this write, and the console names it. One whose `prepare`
throws is left out the same way. The others' `apply` still run, in order.

So a reply never waits more than 5 s for extensions, however many are installed, and one slow extension
never takes time from another.

Your extension cannot make the turn's write wait for it. The turn's write happens when mvu-helper's own work
is done: its POST pass, and every edit its own stages are still making (pictures included). A hand-in that
arrives after that is written on its own, as one more refresh.

## API6 — Refusals and what they mean

Every refusal is a console warning from `[mvu-helper] [reply-redraw]` naming your `by`:

| The warning says | What to fix |
|---|---|
| `it names chat "…", but chat "…" is open` / `message_id N is not a message index` / `there is no message N` / `message N is the user's, not a reply` | the request's `chat_id` or `message_id` |
| `swipe S of message N is not the one showing` | the request's `swipe_id`: the reply's current `swipe_id` |
| `the reply is gone (regenerated or deleted)` / `another swipe of it is showing` / `another chat is open now` | nothing: the reply your work was for is not on screen any more |
| ``it has no `by` name`` / `its stage "…" is neither "content" nor "presentation"` / `it has no apply(text) function` / `its prepare is not a function` | the edit object (API3) |
| `apply returned a Promise` / `apply returned undefined, not the text` / `apply threw` | `apply` (API3) |
| `it is the second edit from this extension in one write` | combine your edits into one |
| `the last call had already ended` | offer the edit before your listener returns |
| `prepare was still running 5s after the last call began — cut off` | move the slow work earlier: a hand-in once it is done |

## API7 — Two worked examples

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

galgame-companion is a last-call editor too (`src/features/beat-shaper/beat-shaper.js`, `offerShapeAtLastCall`):
its `prepare` files the backdrops its shaped text names, and its `apply` shapes the reply into galgame's beats.

## API8 — Reading mvu-helper's log line for a write

Turn on mvu-helper's `pipeline` debug domain. Each write that ran an extension edit prints one line naming
every editor in queue order and what became of it:

```text
[mvu-helper] [reply-redraw] msg 46: extension edits at the turn's end — my-summary (content) changed +212 · galgame-companion (presentation) changed +96
[mvu-helper] [reply-redraw] msg 46: one write at the turn's end for logic-engine RES reply text, imagegen draw pass, POST receipt, hand-in from my-summary
```

An editor's entry reads `changed +N` (characters added, `-N` removed), `unchanged`, `cut off at the window's
end`, `dropped: prepare threw`, or `refused: <why>`. A hand-in written after the turn reads `on its own` in
place of `at the turn's end`.

## API9 — The code behind it

Every function below is in `src/features/reply-redraw/`; the pure ones (`-core.js`) are tested in
`tests/reply-redraw-core.test.js`.

| Step | Function | What it does |
|---|---|---|
| the names | `EDIT_REQUEST_EVENT`, `LAST_CALL_EVENT`, `LAST_CALL_WINDOW_MS` (reply-redraw.js) | `mvu_helper_reply_edit`, `mvu_helper_reply_last_call`, `5000`. Public: renaming one breaks every extension that uses it |
| reserving a reply | `onEditRequest` → `resolveReplyAddress` (core) | checks `chat_id` against the open chat, `message_id` against the chat, the message is not the user's, and `swipe_id` is the one showing. Binds `request.handIn` to the reservation `{ chatId, message, swipe }`; a refused request gets a `handIn` that always returns `'refused'` |
| handing in | `handInEdit` → `replyEditProblem`, `locateReservedReply` (core) | checks the edit's shape, then finds the reserved reply again by its message object (`chat.indexOf(message)`), so a deleted message above it moves its index without losing it. A record open for that take: `holdHandIn` (one per `by`, a newer one replaces the older) and `noteRedrawOwed(record, 'text', 'hand-in from <by>')`, so the turn's write happens even when mvu-helper itself edited nothing. No record: `writeReplyText` now, with `isOwed: false` |
| taking the hand-ins | `takeHandIns` (core) | the turn's write empties the record's hand-ins, so no write applies one twice |
| the last call | `collectReplyEdits` | emits `LAST_CALL_EVENT` with `{ chat_id, message_id, swipe_id, edit }` and races it against the window; `edit` checks `replyEditProblem` and queues while collecting. Then `queueReplyEdits(handIns, offered)` (hand-ins first, a second edit per `by` refused), `orderReplyEdits` (stage rank, then code-point `by`), and `prepareWithinWindow(ordered, message.mes, msLeft)`: every `prepare` at once on mvu-helper's text, each cut off and aborted at the window's end |
| applying | `writeReplyText` → `runApplyChain` (core) | checks the take is still showing (a swipe during the last call writes nothing), runs each ready editor's `apply` on the previous one's output (a throw, a Promise or a non-string refuses that editor and the next gets the text it was given; a refused Promise's rejection is logged), sets `message.mes` when the chain changed it, logs `replyEditorsLine`, and calls `commitReplyTextEdit` when mvu-helper owed a write or the chain changed the text |
| who calls it | `redrawReply` (no record), `writeHeld` (a record's `text` write), `handInEdit` (no record) | every text write; `saveRedrawnReply` and a record's `save` write emit no last call |
