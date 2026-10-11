# Entries

> This page applies to any game. ArtificKoi shows up as a real example, not as a rule. See [A general design, with one real example](technical.md#a-general-design-with-one-real-example).

Entries are the lorebook entries your pack writes onto the card. They're what the models read.

Who reads which entry, and how an entry feeds the engine, is on [How a GameLogic Engine works](technical.md#who-reads-which-entry). This page is the file format.

## One entry, 2 files

Each entry is 2 files with the same name, anywhere under `entries/`:

- `<name>.txt` > the content, what the model reads.
- `<name>.json` > the fields, everything else about the entry.

Every `.txt` needs its `.json` and the other way around. Entries are ordered by their path.

Here's ArtificKoi's `entries/windows/check_dc_dice-pre.json`, cut down to the fields that matter most:

```json
{
  "comment": "[PRE] Check_DC_Dice",
  "type": "selective",
  "keys": [],
  "position": "before_character_definition",
  "order": 777,
  "enabled": true
}
```

The real file carries the rest of the usual SillyTavern entry fields too. The content sits next to it in `check_dc_dice-pre.txt`.

The `.json` rules:

- It's a Tavern Helper lorebook entry without `content`. It can't carry `content`, `uid` or `display_index`.
- Constant, selective and vectorized are written as `"type": "constant"` and so on. A `true`/`false` field for them is refused, because Tavern Helper drops it and the entry would never inject.

## What install does to an entry

The install writes each entry into the card's lorebook with `[GameLogicPack:<id>] ` in front of its comment. So ArtificKoi's `[PRE] Check_DC_Dice` lands as `[GameLogicPack:school-v4] [PRE] Check_DC_Dice`.

That prefix is how Uninstall finds the pack's entries later. The `[PRE]` tag still routes, because a call picks up its tag anywhere in the comment.

Every other field is copied as it is, except `uid`, which belongs to the source lorebook and is dropped.

A comment can't contain `[mvu_`, `[gamelogicpack:`, `[statusmenupack:` or `[gamelogicplugin:`. MVU Helper's installer owns those names.

## The seed

Your card's starting state, its MVU seed, is an ordinary entry. Ship the card's `[InitVar]` entry here, same as any MVU card does.

MVU Helper re-applies it on every chat load, and only adds what's missing. It never overwrites a value that's already there. To fix a value in old saves, see [State corrections](state.md).

## Checks

Every import checks your entries' EJS:

- **Each entry's EJS has to compile.** All the `<% %>` parts of one entry are compiled together, as one piece of code.
- **No two enabled constant entries can declare the same name.** Constant entries render together, in one scope. If 2 of them both declare `const sd`, the second one breaks the render.

[Back to How a GameLogic Engine works](technical.md) · [Back to index](../../README.md)
