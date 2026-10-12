# The plugin file

> A plugin is written for any game. ArtificKoi shows up as a real host, not as a rule. See [Written for any game](technical.md#written-for-any-game).

A plugin ships as one JSON file. You don't write that file by hand, though. You write a folder, and the dev loop or Import source folder puts it together.

## The file

It's the same envelope as a GameLogic Pack. `packType` is what makes it a plugin.

```jsonc
{
  "format": "1.0",
  "packType": "plugin",            // required, this is what makes it a plugin
  "id": "weather",                 // required, kebab-case, unique in the library
  "name": "Weather",               // required, shown in the library and the install dialog
  "description": "…",              // required, the one line a player reads before installing
  "version": "1.2.0",              // 2 or 3 whole numbers, compared on install and for Upgrade
  "builtWith": "hand-authored",    // free text, a receipt

  "entries": [ /* prompt entries */ ],
  "schema":  "…registerMvuSchema…",// required, declares GameLogicPlugin open and nothing else

  "engine":  "…JS text…",          // optional, resolveRelay and renderPanel
  "panel":   { /* … */ },          // optional, the side panel slot
  "requires":     ["cast@1"],      // optional, unmatched means install is refused
  "optionalUses": ["clock@1"]      // optional, unmatched means it installs and runs without
}
```

2 things a plugin never has:

- **No `init`.** A file with one is refused. A plugin declares no starting state. It creates what it keeps, inside its drawer, when it starts keeping it.
- **No `regex`.** A plugin has no part of the card's screen to restyle.

`requires` and `optionalUses` are what make a plugin game-bound or standalone. They're on [Running on any game](any_game.md). The `engine` is on [The plugin engine](engine.md), and the `schema` on [Writing into stat_data](writing.md#the-schema).

## The folder

This is what you actually write:

```
plugin-<id>/
├── pack.json              # the envelope: format, packType, id, name, description, version,
│                          #   builtWith, requires, optionalUses, plus engineOrder
├── entries/
│   ├── record.json        # one entry's fields: comment, order, position, type …
│   └── record.txt         # its content, plain text, no JSON escaping
├── engine/
│   └── relay-resolver.cjs # becomes "engine". Several files are joined in engineOrder
├── schema/
│   └── plugin_root_schema.js  # becomes "schema". Exactly 1 file, required
└── panel/
    └── panel.json         # becomes "panel". Optional
```

So `requires` and `optionalUses` go in `pack.json`. Each entry is 2 files with the same name, one for its fields and one for its text. `engineOrder` in `pack.json` lists the engine files in the order they load.

## The 3 tokens

A plugin can't know 2 things about the card it lands on: what the player named their LLM calls, and which drawer the player picked for it. So your entries leave blanks, and the installer fills them in:

| Token | Becomes | Why |
| --- | --- | --- |
| `{PRE_CALL}` | `[<the PRE call the player picked>]` | the plugin can't know what the player named their calls |
| `{POST_CALL}` | `[<the POST call the player picked>]` | same |
| `{OWN_ROOT}` | `GameLogicPlugin.<the drawer the player picked>` | 2 copies of one plugin must be able to sit side by side |

It's like a contract with a blank for the name. The form is written once, and every signer fills in their own.

**Using a token is how you say you need it.** If any entry has `{POST_CALL}`, the install dialog asks for a POST call. If none does, it doesn't ask. If the player has no call set up for a phase you need, install refuses and says so, instead of writing an entry routed to nothing.

Any other `{UPPERCASE}` token is warned when you validate. The installer leaves it as is, so it would reach the model word for word. Lowercase braces, like `{{user}}` or `{name}`, are never touched.

An entry's comment can't contain `[GameLogicPlugin:`, `[GameLogicPack:`, `[StatusMenuPack:` or `[MVU_`, anywhere. Those names belong to the installer.

[Back to How a GameLogic Plugin works](technical.md) · [Back to index](../../README.md)
