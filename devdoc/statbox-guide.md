# The StatBox — a per-reply stat summary in the story text

**Audience: a card author, any genre.** You declare which stats matter; mvu-helper shows the player
which of them moved after every reply, inside the reply itself:

```text
<styled type="terminal" title="Scene Stats">
Critblade: CHA 51 (+1)
Mitsuki Tachibana: Affection 18 (+3)
</styled>
```

Everything here is declared by your card: which records, which fields, what they are called, and what
wraps the lines. mvu-helper knows nothing about your game. It compares numbers and prints what you told
it to print. You write one `statBox` section and two regex scripts, and that is all.

---

## 1. What the player sees

After a reply lands, the box sits at the end of the story text with one line per member whose declared
fields changed in this reply:

| The field… | Prints |
|---|---|
| is a number on both sides and went up / down | `Label 13 (+3)` / `Label 7 (-3)` |
| is anything else and changed | `Label Friend → Crush` |
| had no value before | `Label 20` |
| reset this reply (§4) | nothing, or `Label 20` — your choice |
| is a note (`"show": "whenSet"`, §3) holding text | `Label text`, or the text alone — changed or not |
| did not change | nothing |

A member that did not exist in the previous reply prints as `Name: new · Label 0 · …`. A member is printed
whether or not the scene features them, so a familiar that gained exp in the background shows up too.
Nothing moved → no box at all.

**What "this reply" is compared against.** The previous assistant reply that carries MVU state, read at
its active swipe. Every swipe and regenerate of a reply is compared against that same baseline. The user's
own message is skipped even when it carries state, so anything a PRE call wrote this turn counts toward
this reply's box. A message with no earlier state at all, such as the greeting, gets no box: there is
nothing to compare against.

**It is frozen.** The box is written into the message, so scrolling back shows each reply's own numbers,
and each swipe keeps its own box.

**Names** come from the field you point `nameField` at, with `{{user}}` and `{{char}}` expanded: a player
record named `{{user}}` prints as the user's name. No other macro is expanded: a name is stat_data, and
SillyTavern's other macros can change variables as they expand.

**A line that would make the page run the reply is left out.** The box is part of the reply's text, where
TavernHelper renders text carrying `html>`, `<head>` or `<body` as a web page and ST-Prompt-Template runs
`<%` as a template. A line whose name or values carry one of them is dropped, and the console names the
member (§9).

---

## 2. What it needs

MVU and a `statBox` section (§3), nothing else. The box goes out with the reply's one write at the end of the
turn (`devdoc/editing-a-finished-reply.md`), so it costs no render of its own. It is built at up to three moments
per reply, each refreshing the box already there:

- **when MVU has read the reply's state** (its parse of the reply's `<UpdateVariable>`, or of POST's record):
  on every card that declares a box, with a GameLogic engine or without;
- **after RES1**, from RES1's state, when a GameLogic engine resolves the turn;
- **at the end of the post-reply phase**, from the turn's final state after POST and RES2, when that phase
  waited for the turn's own work: at least one POST call ran, or a GameLogic engine resolves turns.

**A changed `statBox` reaches existing players on its own.** Every chat load compares the card's
`[Initmvuhelper]` with the config the player last imported, and a changed one is re-imported, so the new
box arrives with the card upgrade. **Re-import from card** (Main tab) does the same on demand.

---

## 3. The `statBox` section

It goes in your card's `[Initmvuhelper]` entry, beside `extraLlmCalls`. School's:

```json
{
  "statBox": {
    "open": "<styled type=\"terminal\" title=\"Scene Stats\">",
    "close": "</styled>",
    "placeBefore": ["</maintext>", "</gametxt>", "<combat_log>"],
    "groups": [
      {
        "path": "Mainchar",
        "kind": "record",
        "nameField": "Name",
        "fields": [
          { "path": "Str", "label": "STR" },
          { "path": "Sta", "label": "STA" },
          { "path": "Int", "label": "INT" },
          { "path": "Cha", "label": "CHA" },
          { "path": "Money", "label": "Money" }
        ]
      },
      {
        "path": "Classmate",
        "kind": "collection",
        "nameField": "Name",
        "fields": [
          { "path": "RelationshipStage", "label": "Stage" },
          { "path": "Affection", "label": "Affection", "resetWith": "RelationshipStage", "onReset": "hide" }
        ]
      }
    ]
  }
}
```

An RPG card, for comparison: a hero, and a party whose members all gain exp:

```json
{
  "statBox": {
    "open": "<styled type=\"terminal\" title=\"Battle Report\">",
    "close": "</styled>",
    "placeBefore": ["</maintext>"],
    "groups": [
      {
        "path": "Hero",
        "kind": "record",
        "nameField": "Name",
        "fields": [
          { "path": "Level", "label": "Level" },
          { "path": "Exp", "label": "Exp", "resetWith": "Level", "onReset": "value" }
        ]
      },
      {
        "path": "Party",
        "kind": "collection",
        "nameField": "Name",
        "fields": [
          { "path": "Level", "label": "Level" },
          { "path": "Exp", "label": "Exp", "resetWith": "Level", "onReset": "value" },
          { "path": "HP", "label": "HP" }
        ]
      }
    ]
  }
}
```

| Key | Required | Meaning |
|---|---|---|
| `open` / `close` | yes | The text around the lines. mvu-helper never interprets it; the pair is how it finds its own box again (§5). |
| `placeBefore` | yes | Where the box may go: your story envelope's closing tags, then any tag every reply prints right after the story. The box goes right before the first of these found in the reply (§5). |
| `groups[].path` | yes | stat_data dot-path to the group. |
| `groups[].kind` | yes | `record`: the path IS one member (a player, a hero). `collection`: every key under the path is a member (a roster, a party). |
| `groups[].nameField` | no | The member's field that holds its display name. Absent or blank → the collection key, or the record path's last segment. |
| `fields[].path` | yes | Dot-path under the member. MVU's `[value, "Label"]` tuples are read as their value. |
| `fields[].label` | yes, except on a note | What the line calls it. A note without one prints its text alone. |
| `fields[].resetWith` | no | Another field in the same `fields` list (§4). |
| `fields[].onReset` | no | `hide` (default) or `value` (§4). |
| `fields[].show` | no | `whenMoved` (default): the field prints when its value changed. `whenSet`: a note, printed whenever it holds text (below). |

Groups print in the order you list them; members in their stored key order. A new stat is one `fields`
row, and a new roster is one `groups` row.

### A note your game logic writes — `"show": "whenSet"`

Some things a player should see are not a stat that moved: a gain your game cut, a resource that ran out.
Your engine writes them as text into a field of the member, for the reply they happened on, and clears the
field when the next reply resolves. Declare that field with `"show": "whenSet"`, and the box prints its text
whenever it holds any, changed or not, and nothing while it is empty. mvu-helper prints the text as written
and never reads it, so the words, the numbers and the language are all your engine's.

School's heroines carry `AffectionCapNote`, which its engine sets when the daily cap cuts a gain. Its
`Classmate` group, with the note after Affection:

```json
{
  "statBox": {
    "open": "<styled type=\"terminal\" title=\"Scene Stats\">",
    "close": "</styled>",
    "placeBefore": ["</maintext>", "</gametxt>", "<combat_log>"],
    "groups": [
      {
        "path": "Classmate",
        "kind": "collection",
        "nameField": "Name",
        "fields": [
          { "path": "RelationshipStage", "label": "Stage" },
          { "path": "Affection", "label": "Affection", "resetWith": "RelationshipStage", "onReset": "hide" },
          { "path": "AffectionCapNote", "show": "whenSet" }
        ]
      }
    ]
  }
}
```

```text
Mitsuki Tachibana: Aff +0 (daily cap 30 reached)
Iori Sekita: Affection 46 (+2) · Aff +2 (daily cap 30 reached)
```

The clearing is your engine's job: a note left in place prints on every later reply.

---

## 4. Resets — `resetWith` and `onReset`

Some fields are reset by your own game logic when another field changes, and a plain before/after on
them is nonsense:

- School: when `RelationshipStage` advances, `Affection` becomes `-1` (a sentinel meaning "freshly
  advanced"); on a demote it becomes `0`. A plain diff would print `Affection -1 (-100)`.
- RPG: on a level-up, `Exp` rolls over to what is left. A plain diff would print `Exp 20 (-75)`.

`resetWith` names the field whose change means "this one was reset". On a reply where that field
changed, no change is printed for this one. `onReset` decides whether the field shows at all:

| `onReset` | School stage advance | RPG level-up |
|---|---|---|
| `hide` (default) | `Mitsuki Tachibana: Stage Friend → Crush` | `Hero: Level 5 (+1)` |
| `value` | `Mitsuki Tachibana: Stage Friend → Crush · Affection -1` | `Hero: Level 5 (+1) · Exp 20` |

School picks `hide` because its reset value is a sentinel a player should never see. RPG picks `value`
because `Exp 20` is real progress into the new level. It is your choice because only your game knows
what its reset value means. mvu-helper only checks whether the sibling changed and never looks at the value.

The next reply is ordinary again: Affection `-1 → 2` prints `Affection 2 (+3)`, the real gain.

The sibling must be in the same `fields` list. That guarantees its own line is printed on the reset reply,
so the player can see why the other field went quiet.

---

## 5. Where the box goes

On its first write, the box is inserted before the first `placeBefore` entry found in the reply, checked
in the order you listed them, at that tag's last occurrence: a closing tag's real place is its last one, and
an earlier one is the tag quoted (reasoning that leaked into the reply quotes the envelope's tags). After
that, the box is found again by its `open`…`close` pair and refreshed in place, wherever it now sits. A later
write never adds a second box.

Two consequences for your config:

- **Make `open` unique to the box.** Any `open`…`close` span in the reply is taken for the box. Give it
  something your narrator never writes, such as a `title` attribute.
- **List every spelling of the closing tag your reply can have**, including any spelling something else
  may rewrite it to before the box is built: the box looks for the tags in the text as it is at that
  moment. School lists `</maintext>` and `</gametxt>`.
- **A reply written without its envelope** (a preset that puts the story in a tag of its own) has none of
  those. List after them a tag every reply prints right after the story, and the box goes before it. School
  lists `<combat_log>`: galgame-companion closes the envelope it inserts into such a reply before that tag,
  so the box still ends up inside it.

A reply that ends without its envelope's closing tag has no anchor: it was cut off, or the narrator wrote
it without the envelope. No box is written, and the console says so:

```text
[statbox] MVU parse msg 12: none of the card's placeBefore anchors (</maintext> </gametxt>) is in the reply, so the box was NOT written — the reply ends without its envelope's closing tag: cut off (a [reply-integrity] TRUNCATED warning names that) or written without the envelope
```

A closing tag that something adds later, such as a repair after the turn, does not bring the box with it:
the box is built only at the moments in §2. A reply that gains its anchor afterwards gets its box the next
time one of them runs for it, which at the latest is when MVU parses the player's next message.

The box is never appended anywhere else, because a box outside the story envelope would be invisible in
the galgame GUI (§7).

---

## 6. The two regex scripts your card ships

The box is in the message text, so SillyTavern would send it back to the model on every later turn and
would display it however its sanitizer likes. Two regex scripts in your card fix both. Key both of them
on your own `open`/`close`. School's:

**PromptDeTag — keep it out of the prompt** (`display: false`, `prompt: true`). The model must never read
numbers it did not compute, and it must not see a box it could imitate. The script deletes the box
outright rather than replacing it with a placeholder.

```json
{
  "script_name": "PromptDeTagStatBox",
  "enabled": true,
  "find_regex": "/<styled type=\"terminal\" title=\"Scene Stats\">[\\s\\S]*?<\\/styled>\\n?/g",
  "replace_string": "",
  "trim_strings": [],
  "source": { "user_input": false, "ai_output": true, "slash_command": false, "world_info": false, "reasoning": false },
  "destination": { "display": false, "prompt": true },
  "run_on_edit": true,
  "min_depth": null,
  "max_depth": null
}
```

**Display — dress it in the SillyTavern chat** (`display: true`, `prompt: false`). SillyTavern's sanitizer
drops an element it does not know, such as `<styled>`, so without this the lines show as bare text.

```json
{
  "script_name": "DisplayStatBox",
  "enabled": true,
  "find_regex": "/<styled type=\"terminal\" title=\"Scene Stats\">\\n?([\\s\\S]*?)\\n?<\\/styled>/g",
  "replace_string": "<div style=\"border: 1px solid #3e4047; border-radius: 8px; margin: 8px 0;\"><div style=\"font-weight: 600; padding: 6px 12px;\">📊 Scene Stats</div><pre style=\"margin: 0; padding: 8px 12px; white-space: pre-wrap;\">$1</pre></div>",
  "trim_strings": [],
  "source": { "user_input": false, "ai_output": true, "slash_command": false, "world_info": false, "reasoning": false },
  "destination": { "display": true, "prompt": false },
  "run_on_edit": true,
  "min_depth": null,
  "max_depth": null
}
```

**Your open tag now exists in three places**: `statBox.open`, and both regexes. Change one, change all
three. School's build tests that they agree (`Tools/test_display_bars.cjs`); a card of yours should do
the same.

mvu-helper's own readers need neither script. POST's input and history, and the roster's mention scan,
strip the box themselves.

---

## 7. galgame

galgame reads the raw message, never the display regex, and builds its segments only from the story
envelope's body. So:

- The box must sit **inside** the envelope. That is what `placeBefore` is for.
- `<styled type="terminal" title="…">` is galgame's own block: it draws the lines as a terminal box titled
  with `title`, after the last prose beat. A `Name: text` line becomes a sender row when the name is 1–20
  characters; a longer name shows the line whole.
- The box is found again by its `open`…`close` pair (§5), so anything that rewrites the reply must leave
  those two strings as they are for the box to be refreshed in place.

mvu-helper never interprets `open`/`close`, so any wrapper works for the SillyTavern chat. `<styled>` is
simply the one galgame understands.

---

## 8. When the config is wrong

Nothing in `statBox` can break the rest of your card. mvu-helper drops the smallest piece it does not
understand, keeps everything else, and names what it dropped in the console when the card config is
imported. **A dropped piece behaves as if you had never written it**, unless that would print a wrong
number. In that case the field or group that owns it is dropped instead.

| You wrote | Dropped | Why that much |
|---|---|---|
| a key mvu-helper does not know, on the section, a group or a field | that key | a key nothing reads changes nothing |
| `onReset` with an unknown value | `onReset`, so `hide` applies | `hide` never prints a wrong number |
| `onReset` without `resetWith` | `onReset` | it has nothing to act on |
| `resetWith` naming no field in the same list | the field | without its reset rule it would print a bogus change on every reset |
| `show` with an unknown value | `show`, so the field prints when it moves | a moved value is never a wrong number |
| a field without `path`, or without `label` when it is not a note | the field | nothing to read, or nothing to call it |
| `kind` missing or unknown | the group | guessing wrong would list a record's fields as members |
| a group without `path`, or with no usable field left | the group | nothing to read |
| `open`/`close` not strings, `placeBefore` empty, `groups` not a list, or `statBox` not an object | the section: no box | no wrapper, or nowhere to put it |

Search the console for these two lines:

```text
[mvu-helper] [card-config] IGNORED 1 unrecognised setting(s): statBox.theme. Nothing was imported for them (…)
[mvu-helper] [card-config] "statBox.groups[1] "Party".kind" was NOT imported — "tree" is not a kind this mvu-helper knows (record, collection) — the group was ignored.
```

The first is a typo or a key from a newer mvu-helper; the message says which, based on the `version`
your card declares. The second is a value mvu-helper understood the key of and refused.

**A misspelled path** (`"Afection"`) is a valid path to nothing, so the import cannot catch it. It is
checked against real state instead, the first time a box is built in each chat. A path that resolves in
none of its group's members is reported once:

```text
[statbox] the card's statBox declares "Classmate.Afection", which resolves to nothing — the field is not in any of the 5 member(s) of "Classmate", so "Affection" never prints. Check its spelling against the card's schema.
```

The same check covers a group's `path` and its `nameField`. A field missing on only some members is not
reported, because that is a partly filled roster, and neither is an empty collection.

---

## 9. Troubleshooting

Turn on the **pipeline** debug domain. Every write says what it did:

```text
[statbox] MVU parse msg 12: inserted — 2 line(s) against baseline msg 10
[statbox] logic-engine RES msg 12: replaced — 2 line(s) against baseline msg 10
[statbox] turn end msg 12: unchanged — 2 line(s) against baseline msg 10
```

Each line opens with the moment that built the box (§2). `inserted` / `replaced` / `removed` / `unchanged`
is what happened to the box; the baseline is the message the numbers were compared against.

| Symptom | Look at |
|---|---|
| No box ever | The section was not imported: see §8's lines, which print when the card's config is imported (its first load, a changed config, or Re-import from card). |
| No box on one reply | Nothing declared moved, or the reply had no closing tag for its envelope (§5's warning). |
| One stat never appears | Its `path` is misspelled: look for `resolves to nothing` (§8). |
| One member's line is missing | Look for `left out of the box`: its name or a value carries `html>`, `<head>`, `<body` or `<%` (§1). |
| The box reaches the model's prompt | The PromptDeTag script is missing, or its open tag differs from `statBox.open`. |
| Bare lines in the SillyTavern chat | The Display script is missing, or its open tag differs. |
| A change looks too big | It is measured against the baseline message in the log line. Check that message's state. |
| The box appeared, then vanished | Something rewrote the reply from a copy older than the box. Check that MVU is v0.189.0 or later (older MVU did this); on a current MVU, look for a script that edits `message_content` in `mag_before_message_update`. |
