# What's in a GameLogic Pack

> This page applies to any game. ArtificKoi shows up as a real example, not as a rule. See [A general design, with one real example](technical.md#a-general-design-with-one-real-example).

A GameLogic Pack is your game, packed up so it can be installed onto a character card.

The way I see it, SillyTavern is the console, the character card is the cartridge, and the GameLogic Pack is the game written onto that cartridge.

## What a pack carries

- the engine > your JavaScript, `resolveTurn` and the other hooks. See [The hooks in detail](hooks.md).
- entries > the lorebook entries the models read. See [Entries](entries.md).
- schema > the Zod schema that decides what can go into each variable. See [Schema](schema.md).
- regex > rules that hide or restyle text. See [Regex](regex.md).
- state > fixes for saves that already exist. See [State corrections](state.md).
- exposes > tells plugins where things live in your game. See [Exposes](exposes.md).
- panel > an optional slot in MVU Helper's side panel. See [Side Panel](../side_panel/README.md).

Every piece is optional except the engine you actually want to run. One GameLogic Pack is active per card.

The install records every piece it wrote. That's how Repair, Upgrade, Uninstall and Export always know exactly which pieces are the pack's. See [Import, install and uninstall](install.md).

## You write a folder, MVU Helper makes the file

You work in a folder. MVU Helper assembles it into one JSON file, and every install reads that file.

It's a lot easier to edit one entry in its own file than to edit one giant JSON. That's the only reason the folder exists.

```
gamelogic/
├── pack.json           identity, engineOrder, state, exposes
├── engine/             the engine: one or more files, joined in engineOrder
├── entries/            one prompt entry = <name>.txt (its content) + <name>.json (its fields)
├── schema/             exactly one file: the Zod registration script
├── regex/              one regex per .json file, plus regex-order.json for their order
└── panel/panel.json    optional side panel declaration
```

The folder rules:

- Only `pack.json` sits at the root, and only these folders. `layout/` and `events/` belong to other pack types and are refused here.
- Any path with a part starting with `.`, and any `README.txt` or `README.md`, is ignored. So you can keep notes right in the folder.
- `engineOrder` in `pack.json` must name every file in `engine/`, and every name must exist. The files are joined in that order, with nothing in between. A file that doesn't end with a newline is warned, because its last line would merge with the next file's first line.
- `schema/` holds exactly one file, any name. `panel/` holds only `panel.json`.

A workspace can hold more than one pack. A folder with its own `pack.json` is one pack. Otherwise, each subfolder with a `pack.json` is one.

## ArtificKoi's pack.json

```json
{
  "format": "1.0",
  "packType": "gamelogic",
  "id": "school-v4",
  "name": "ArtificKoi — School v4",
  "description": "Koikatu-style school dating sim: LogicEngine, schema, worldview and PRE/POST entries. The heroine profiles ship on the card itself.",
  "version": "5.132.0",
  "builtWith": "Tools/build_workspace.cjs",
  "engineOrder": ["i18n.cjs", "eventpack.cjs", "globalLogic.cjs"],
  "exposes": {
    "cast@1": "Classmate",
    "player@1": "Mainchar",
    "location@1": "World.Location",
    "landmarks@1": "WorldRecord.Locations",
    "chronicle@1": "WorldRecord.Events",
    "clock@1": "World"
  },
  "state": { "version": "0.1.0", "force": {} }
}
```

Its engine is 3 files joined into one. How that works is on [Where the engine runs](runtime.md#an-engine-in-several-files).

## The fields

| Field | Required | What it does |
| --- | --- | --- |
| `format` | yes | The pack format. MVU Helper understands `"1.0"`. |
| `packType` | yes | Always `"gamelogic"` for this pack type. |
| `id` | yes | Lowercase with dashes, like `my-game`. It goes in front of every lorebook comment the install writes, so keep it the same once you publish. `registry` is reserved. |
| `name` | yes | The name people see, any language. |
| `description` | yes | One line, shown in the library and the install dialog. |
| `version` | no, but warned | 2 or 3 whole numbers with dots, like `"1.4"` or `"1.4.0"`. `"v1.4"` or `"1.4-beta"` is refused. Install compares it number by number to tell Upgrade, Repair and Downgrade apart. |
| `builtWith` | no | A note on which tool made the file. Stored, never read. |
| `engine`, `entries`, `schema`, `regex`, `regexOrder` | no | Assembled from the folders. |
| `state`, `exposes` | no | Written right in `pack.json`. |
| `panel` | no | Assembled from `panel/panel.json`. |

A field that isn't in this table is warned and not installed, and everything else still installs. A field that belongs to another pack type (`layout`, `targetsPackId`, `requires`, `optionalUses`, `events`) gets the pack refused.

## The panel

`panel` puts a slot in MVU Helper's side panel. Its paths read straight from `stat_data`. Or your engine can export `renderPanel(ctx)` and work out the slot itself. The format is on the [Side Panel](../side_panel/README.md) page.

## Checks on every import

Every door into MVU Helper judges a pack the same way: folder, ZIP, file, paste, the dev loop, and every install from the library. On top of each piece's own rules, it checks that:

- the engine compiles.
- each entry's EJS compiles.
- no two enabled constant entries declare the same name in their EJS.
- the engine declares `ENGINE_NAME`. That one is only a warning, but plugins that branch on your game's name can't tell yours apart without it.

## The smallest pack that works

```
gamelogic/
├── pack.json
└── engine/
    └── gameLogic.cjs
```

```json
{
  "format": "1.0",
  "packType": "gamelogic",
  "id": "my-game",
  "name": "My Game",
  "description": "A game that resolves its turns.",
  "version": "0.1.0",
  "engineOrder": ["gameLogic.cjs"]
}
```

With `engine/gameLogic.cjs` holding a `resolveTurn`, like the goblin example on [What is GameLogic Engine](README.md). GameLogic Packs tab > Add New Blank Packs gives you exactly this, plus an example entry, regex and schema. So does the template workspace, with a sample of every other pack type too. See [Get a starting point](install.md#get-a-starting-point).

[Back to How a GameLogic Engine works](technical.md) · [Back to index](../../README.md)
