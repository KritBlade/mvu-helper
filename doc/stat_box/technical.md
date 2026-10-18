# How the stat box works

> This page applies to any card. ArtificKoi shows up as a real example, not as a rule.

The stat box is a few lines MVU Helper writes into the end of a reply's story: every declared stat that moved in this reply. Your card declares everything. MVU Helper compares the numbers and prints what you told it to print.

## What's on this page

1. [What it prints](#what-it-prints) > the line formats, what "this reply" is compared against, and why the box never changes later.
2. [When it's built](#when-its-built) > the 3 moments, and how a changed box reaches your players.
3. [The `statBox` section](#the-statbox-section) > ArtificKoi's real one, an RPG one, and every key.
4. [Resets](#resets-resetwith-and-onreset) > `resetWith` and `onReset`.
5. [Where the box goes](#where-the-box-goes) > `placeBefore`, and the reply that has no anchor.
6. [The 2 regex scripts](#the-2-regex-scripts) > keeping it out of the prompt, and drawing it in the chat.
7. [galgame](#galgame) > why the box has to sit inside the story.
8. [When the config is wrong](#when-the-config-is-wrong) > what gets dropped, and how much.
9. [Checking your work](#checking-your-work) > the log lines, and what to look at for each problem.

## What it prints

One line per character whose declared stats changed in this reply:

| The stat... | Prints |
| --- | --- |
| is a number before and after, and went up or down | `Label 13 (+3)` / `Label 7 (-3)` |
| is anything else, and changed | `Label Friend → Crush` |
| had no value before | `Label 20` |
| was reset this reply, see [Resets](#resets-resetwith-and-onreset) | nothing, or `Label 20`, your choice |
| didn't change | nothing |

Stats on one line are joined with ` · `. A character who didn't exist in the last reply prints as `Name: new · Label 0 · …`.

A character is printed whether or not the scene shows them. So a familiar who gained exp in the background shows up too. Nothing moved, and there's no box at all.

### What "this reply" is compared against

The last assistant reply before it that carries MVU state, on the swipe you're looking at.

- **Every swipe and regenerate is compared against that same reply.** So 3 swipes of one reply are 3 honest answers to the same question.
- **Your own message is skipped,** even when it carries state. So whatever a PRE call wrote this turn counts toward this reply's box.
- **A message with no state before it gets no box.** The greeting has nothing to compare against.

### The box never changes later

The box is written into the message text. So scrolling back shows every reply's own numbers, and every swipe keeps its own box.

### Names

The name comes from the field you point `nameField` at, with SillyTavern macros filled in. A player record whose name is `{{user}}` prints your persona's name.

## When it's built

All it needs is MVU and a `statBox` section. It goes out with the reply's one write at the end of the turn, so it costs no extra redraw.

It's built at up to 3 moments in a reply, and each one refreshes the box already there:

1. **When MVU has read the reply's state:** its parse of the reply's `<UpdateVariable>`, or of POST's block. On every card that declares a box, with a game engine or without.
2. **After RES1,** from RES1's state, when a GameLogic Engine resolves the turn.
3. **At the end of the reply,** from the final state after POST and RES2. Only when that phase waited for the turn's own work: at least one POST call ran, or a GameLogic Engine resolves turns.

So the box always ends up showing the turn's final numbers, whatever your card runs.

### A changed box reaches your players by itself

Every chat load compares the card's `[Initmvuhelper]` with what the player last imported. A changed one is imported again, so a new or fixed `statBox` arrives with your card's upgrade. **Re-import from card**, on the Main tab, does the same right away. How the card config travels is on [Set up the calls](../extra_llm_calls/calls.md).

## The `statBox` section

There's no tab for it. You write it by hand in your card's `[Initmvuhelper]` entry, next to `extraLlmCalls`. **Export config → card** keeps it, minus anything it dropped on import.

This is ArtificKoi's:

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
          { "path": "Affection", "label": "Affection", "resetWith": "RelationshipStage", "onReset": "hide" },
          { "path": "Lewdness", "label": "Lewdness" }
        ]
      }
    ]
  }
}
```

2 groups. `Mainchar` is one character, you. `Classmate` is every classmate on file, each one a line of her own when her stats move.

An RPG for comparison, a hero and a party whose members all gain exp:

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

| Key | Required | What it means |
| --- | --- | --- |
| `open` / `close` | yes | the text around the lines. MVU Helper never reads what's inside them. The pair is how it finds its own box again |
| `placeBefore` | yes | where the box may go: your story's closing tags, then any tag every reply prints right after the story. See [Where the box goes](#where-the-box-goes) |
| `groups[].path` | yes | the dotted path to the group in `stat_data` |
| `groups[].kind` | yes | `record`: the path IS one character, like a player or a hero. `collection`: every key under the path is a character, like a class or a party |
| `groups[].nameField` | no | the character's field that holds the name to print. Left out or blank, it's the collection key, or the last part of the record's path |
| `fields[].path` | yes | the dotted path inside the character. An MVU pair, `[value, "Label"]`, is read as its value |
| `fields[].label` | yes | what the line calls it |
| `fields[].resetWith` | no | another field in the same `fields` list. See [Resets](#resets-resetwith-and-onreset) |
| `fields[].onReset` | no | `hide`, the default, or `value` |

Groups print in the order you list them, and characters in the order they're stored. A new stat is one more `fields` row, and a new roster is one more `groups` row.

## Resets: `resetWith` and `onReset`

Some stats are reset by your own game when another stat changes. A plain before and after on them is nonsense:

- **ArtificKoi:** when `RelationshipStage` goes up, `Affection` becomes `-1`, a marker that means "just went up". When it goes down, `Affection` becomes `0`. A plain before and after would print `Affection -1 (-100)`.
- **An RPG:** on a level up, `Exp` rolls over to what's left. A plain before and after would print `Exp 20 (-75)`.

`resetWith` names the stat whose change means "this one was reset". On a reply where that stat changed, no change is printed for this one. `onReset` says whether it shows at all:

| `onReset` | ArtificKoi, stage goes up | RPG, level up |
| --- | --- | --- |
| `hide`, the default | `Mitsuki Tachibana: Stage Friend → Crush` | `Hero: Level 5 (+1)` |
| `value` | `Mitsuki Tachibana: Stage Friend → Crush · Affection -1` | `Hero: Level 5 (+1) · Exp 20` |

ArtificKoi picks `hide`, because `-1` is a marker no player should ever see. The RPG picks `value`, because `Exp 20` is real progress into the new level. It's your choice, because only your game knows what its reset value means. MVU Helper only checks whether the other stat changed, and never looks at the value.

The next reply is normal again. Affection going from `-1` to `2` prints `Affection 2 (+3)`, the real gain.

The stat named in `resetWith` has to be in the same `fields` list. That way its own line is printed on the reset reply, and the player can see why the other one went quiet.

## Where the box goes

The first time, the box goes right before the first `placeBefore` tag found in the reply, checked in the order you listed them. It goes before that tag's LAST appearance, because a closing tag's real place is its last one. An earlier one is the tag quoted, like reasoning that leaked into the reply and mentions the story's tags.

After that, the box is found again by its `open` and `close`, and refreshed where it is. A later write never adds a second box.

3 things that follow for your config:

- **Make `open` unique to the box.** Anything between your `open` and `close` is taken for the box. So give it something the narrator never writes, like a `title`.
- **List every spelling of the closing tag your reply can have,** including one something else may rewrite it to before the box is built. ArtificKoi lists `</maintext>` and `</gametxt>`.
- **A reply written without its story tags** has none of those. Maybe a preset puts the story in a tag of its own. So after them, list a tag every reply prints right after the story, and the box goes before that one. ArtificKoi lists `<combat_log>`. For such a reply, galgame-companion closes the story tag it adds right before `<combat_log>`, so the box still ends up inside the story.

### No anchor, no box

A reply that ends without its story's closing tag has nowhere to put the box. It was cut off, or the narrator wrote it without the tags. No box is written, and the console says so:

```text
[statbox] MVU parse msg 12: none of the card's placeBefore anchors (</maintext> </gametxt>) is in the reply, so the box was NOT written — the reply ends without its envelope's closing tag: cut off (a [reply-integrity] TRUNCATED warning names that) or written without the envelope
```

A closing tag added later, like a repair after the turn, doesn't bring the box with it. The box is only built at the 3 moments above. The reply gets its box the next time one of them runs for it, at the latest when MVU reads the player's next message.

The box is never put anywhere else. A box outside the story would be invisible in the galgame GUI.

## The 2 regex scripts

The box is part of the message text. So SillyTavern would send it back to the AI on every later turn, and would display it however its cleaner likes. 2 regex scripts in your card fix both. Both of them look for your own `open` and `close`.

These are ArtificKoi's.

### Keep it out of the prompt

`PromptDeTagStatBox`, prompt only. The AI must never read numbers it didn't work out, and it must not see a box it could copy into its own reply. So the script deletes the box outright, with no placeholder left behind:

```json
{
  "script_name": "PromptDeTagStatBox",
  "enabled": true,
  "find_regex": "/<styled type=\"terminal\" title=\"Scene Stats\">(?:(?!<styled type=\"terminal\" title=\"Scene Stats\">)[\\s\\S])*?<\\/styled>\\n?/g",
  "replace_string": "",
  "trim_strings": [],
  "source": { "user_input": false, "ai_output": true, "slash_command": false, "world_info": false, "reasoning": false },
  "destination": { "display": false, "prompt": true },
  "run_on_edit": true,
  "min_depth": null,
  "max_depth": null
}
```

The `(?!…)` part stops a match from starting at one box and running into the next one.

### Draw it in the chat

`DisplayStatBox`, display only. SillyTavern's cleaner drops a tag it doesn't know, like `<styled>`. So without this one, the lines show up as bare text:

```json
{
  "script_name": "DisplayStatBox",
  "enabled": true,
  "find_regex": "/<styled type=\"terminal\" title=\"Scene Stats\">\\n?((?:(?!<styled type=\"terminal\" title=\"Scene Stats\">)[\\s\\S])*?)\\n?<\\/styled>/g",
  "replace_string": "<div style=\"border: 1px solid #3e4047; border-radius: 8px; background-color: #1e1e2e; margin: 8px 0; overflow: hidden;\">\n  <div style=\"color: #e0e0e0; font-weight: 600; padding: 6px 12px; border-bottom: 1px solid #3e4047;\">📊 Scene Stats</div>\n  <pre style=\"background-color: #111; color: #e0e0e0; margin: 0; padding: 8px 12px; font-size: 0.85em; white-space: pre-wrap;\">$1</pre>\n</div>",
  "trim_strings": [],
  "source": { "user_input": false, "ai_output": true, "slash_command": false, "world_info": false, "reasoning": false },
  "destination": { "display": true, "prompt": false },
  "run_on_edit": true,
  "min_depth": null,
  "max_depth": null
}
```

**Your open tag now lives in 3 places:** `statBox.open`, and both regexes. Change one, change all 3. ArtificKoi's build tests that the 3 agree, and a card of yours should too.

MVU Helper's own readers need neither script. POST's input, the history macros and the roster's name scan take the box out by themselves.

## galgame

galgame reads the raw message, never the display regex, and it builds its pages only from inside the story's tags. So:

- **The box must sit inside the story.** That's what `placeBefore` is for.
- **`<styled type="terminal" title="…">` is galgame's own block.** It draws the lines as a terminal box titled with `title`, after the last line of prose. A `Name: text` line becomes a sender row when the name is 1 to 20 characters long. A longer name shows the line whole.
- **Anything that rewrites the reply must leave `open` and `close` exactly as they are,** or the box can't be found again and refreshed.

MVU Helper never reads inside `open` and `close`, so any wrapper works for the SillyTavern chat. `<styled>` is just the one galgame understands.

## When the config is wrong

Nothing in `statBox` can break the rest of your card. MVU Helper drops the smallest piece it doesn't understand, keeps everything else, and names what it dropped in the console when the card config is imported.

**A dropped piece behaves as if you never wrote it,** unless that would print a wrong number. Then the field or group that owns it is dropped instead.

| You wrote | Dropped | Why that much |
| --- | --- | --- |
| a key MVU Helper doesn't know, on the section, a group or a field | that key | a key nothing reads changes nothing |
| `onReset` with an unknown value | `onReset`, so `hide` applies | `hide` never prints a wrong number |
| `onReset` without `resetWith` | `onReset` | it has nothing to act on |
| `resetWith` naming no field in the same list | the field | without its reset rule, it would print a fake change on every reset |
| a field without `path` or `label` | the field | nothing to read, or nothing to call it |
| `kind` missing or unknown | the group | guessing wrong would list a record's fields as characters |
| a group without `path`, or with no usable field left | the group | nothing to read |
| `open` or `close` not text, `placeBefore` empty, `groups` not a list, or `statBox` not an object | the whole section, so no box | no wrapper, or nowhere to put it |

Search the console for these 2 lines:

```text
[mvu-helper] [card-config] IGNORED 1 unrecognised setting(s): statBox.theme. Nothing was imported for them (…)
[mvu-helper] [card-config] "statBox.groups[1] "Party".kind" was NOT imported — "tree" is not a kind this mvu-helper knows (record, collection) — the group was ignored.
```

The first is a typo, or a key from a newer MVU Helper. The message says which, from the `version` your card declares. The second is a key MVU Helper knows, with a value it refused.

### A misspelled path

`"Afection"` is a valid path to nothing, so the import can't catch it. It's checked against the real state instead, the first time a box is built in each chat. A path that finds nothing in every character of its group is reported once:

```text
[statbox] the card's statBox declares "Classmate.Afection", which resolves to nothing — the field is not in any of the 5 member(s) of "Classmate", so "Affection" never prints. Check its spelling against the card's schema.
```

The same check covers a group's `path` and its `nameField`. A field missing on only some characters isn't reported, because that's just a roster that isn't filled in yet. Neither is an empty collection.

## Checking your work

Turn on the **pipeline** debug domain on the Main tab. Every write says what it did:

```text
[statbox] MVU parse msg 12: inserted — 2 line(s) against baseline msg 10
[statbox] logic-engine RES msg 12: replaced — 2 line(s) against baseline msg 10
[statbox] turn end msg 12: unchanged — 2 line(s) against baseline msg 10
```

Each line starts with the moment that built the box. `inserted`, `replaced`, `removed` or `unchanged` is what happened to it. The baseline is the message the numbers were compared against.

| What you see | Look at |
| --- | --- |
| no box, ever | the section wasn't imported. Look for the [When the config is wrong](#when-the-config-is-wrong) lines, printed when the card config is imported: its first load, a changed config, or Re-import from card |
| no box on one reply | nothing you declared moved, or the reply had no closing tag for its story. See [No anchor, no box](#no-anchor-no-box) |
| one stat never shows up | its `path` is misspelled. Look for `resolves to nothing` |
| the box reaches the AI's prompt | the PromptDeTag script is missing, or its open tag differs from `statBox.open` |
| bare lines in the SillyTavern chat | the Display script is missing, or its open tag differs |
| a change looks too big | it's measured against the baseline message in the log line. Check that message's state |
| the box showed up, then vanished | something rewrote the reply from a copy older than the box. Make sure MVU is v0.189.0 or later, because older MVU did this. On a current MVU, look for a script that edits `message_content` in `mag_before_message_update` |

Basically, the card says which numbers matter and where the box goes, and MVU Helper prints only what moved, frozen into the reply it belongs to.

[Back to Stat Box](README.md) · [Back to index](../../README.md)
