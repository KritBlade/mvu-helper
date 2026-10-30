# Editing a finished reply — `msg.mes`, `msg.swipes`, `msg.extra`, `.mes_text`

**Audience: anyone writing mvu-helper code (or a GameLogic Plugin) that changes a reply AFTER the
model finished it.** Card authors want `devdoc/dev-helper.md` §1.6 instead — that one says *what* to
write into a reply; this one says *how to write it without breaking what is already mounted in it*.

A finished reply is not a private string. Four surfaces hold it, three other extensions read it, and
frames are mounted inside it. Each rule below names what breaks without it.

---

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
one synchronous chain on the latest `mes`, inside a hard 5 s window (`devdoc/reply-redraw-api.md`). Your own
edit is already in `mes` by then, so the chain sees it.

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

## Verifying a change here

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
