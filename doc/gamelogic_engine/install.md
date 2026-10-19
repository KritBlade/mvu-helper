# Import, install and uninstall

Your pack goes into the library first, and from the library onto a card. Both happen on the GameLogic Packs tab. The tools for building one, the dev loop and the blank packs, are on the Development tab.

## Get a starting point

There are 2 ways to start. Both give you a blank GameLogic Pack that already works.

### The template workspace

The `mvu-helper-template` branch of this repo is a complete workspace, ready to open:

```
git clone -b mvu-helper-template --single-branch https://github.com/KritBlade/mvu-helper.git my-game
```

No git? Open the [branch on GitHub](https://github.com/KritBlade/mvu-helper/tree/mvu-helper-template), then Code > Download ZIP.

Everything sits under `workspace/`:

| Folder | What it is |
| --- | --- |
| `gamelogic/` | a blank GameLogic Pack: `pack.json`, an engine that exports `resolveTurn`, an example entry, a sample regex and a sample schema |
| `plugin-lane-probe/` | a sample GameLogic Plugin that uses all 3 prompt windows (narrate, PRE, POST), dice and its own `resolveRelay` |
| `plugin-standalone-probe/` | a sample GameLogic Plugin that runs with no GameLogic Pack beside it, and shows how to read state it doesn't own |
| `statusmenu/` | a sample StatusMenu Pack |
| `evenpack-test-series/` | a sample Event Pack: a 3-step quest chain |

Start with the template when you want to see every pack type working side by side. You copy what you need and delete the rest.

It also comes with a `CLAUDE.md`, the project rules for an AI coding assistant. So if you vibe code your game, your assistant starts out knowing how the workspace is laid out and which rules to follow.

### From the GUI

MVU Helper > Development tab > Add New Blank Packs > type GameLogic Pack > Create archive.

The ZIP holds only a `gamelogic/` folder, the same blank pack as the template's: `pack.json`, an engine that exports `resolveTurn`, a disabled example entry, a sample regex and a sample schema. Extract it at your workspace root.

## Develop against a live card

The dev loop applies every save in your folder to the open card, so you see your change in the next reply without importing anything by hand.

- An `engine/` save rewrites and reloads the engine.
- An `entries/` or `panel/` save rewrites the entries.
- A `schema/` or `regex/` save rewrites those.
- A `pack.json` save rewrites everything.

Each save runs the same checks an import runs, and a pack with errors is skipped. The loop asks before installing onto a card that doesn't have the pack yet, asks once before replacing pieces the card already owns, never uninstalls anything, and never applies in the lobby.

How to set it up is on [Development Environment and Dev Loops](../dev_env/README.md).

## Import into the library

- **The folder:** Import source folder, or Import source ZIP.
- **The single pack file:** Load file or paste it, then Validate and Add to library.

The library is a lorebook bound to no character, so it survives rebuilding the card. Think of it as your game shelf. Installing is putting a game in the console.

Every door judges a pack the same way: the format rules and the source checks. See [Checks on every import](pack.md#checks-on-every-import). A folder or ZIP can hold several packs. Each one is listed on its own tab: a plugin on this one, a StatusMenu Pack on the StatusMenu Packs tab, and an event pack goes to the Event Packs tab's own library.

## Install, Repair, Upgrade, Downgrade

On the library row: Install to this card.

The On this card row then shows the pack's state as a pill: **Installed**, **Pieces missing** or **No library copy**. It offers Export, the file icon, and Uninstall, the red bin. Repair shows up when pieces are missing from the card, and Upgrade when the library holds a newer version.

The engine and the `Scheme` script count as pieces, so removing the engine makes the row read Pieces missing. If something else replaces either one, such as an engine dev upload or a hand edit, the row gets a **Drift** pill naming it. Repair writes the pack's copy back.

The pack's `version` decides which one an install is. Same version is Repair, newer is Upgrade, older is Downgrade, and Downgrade asks first. An older library copy offers no button of its own, so going back a version is Uninstall, then Install.

All 4 write the same way:

1. Every entry the previous install recorded is deleted, then the pack's entries are written.
2. The engine goes into `[MVU_LogicEngine]`, the schema into the `Scheme` script, and the regexes into the card's regex list. Regexes an older version installed and this one no longer ships are removed.
3. `[GameLogicPack:Registry]` records what was written and owned, a fingerprint of the engine and schema text it wrote, the `state`, the `exposes` map and the pack's identity.
4. The card's state is synced, the `[InitVar]` seed and the `force` map. Then the engine reloads.

## Pieces the card already has

Say the card already carries an engine entry, a `Scheme` script or regexes with the same names, and no install recorded them as the pack's.

- Identical ones are taken over quietly, and logged.
- Different ones make the install ask once whether to replace them.

Pieces taken over belong to the pack from then on, so Uninstall removes them.

## Switching packs

When another GameLogic Pack is active, Install offers to uninstall it first. The save isn't touched either way.

## Uninstall

Uninstall removes exactly what the install recorded: the pack's entries, the engine and the `Scheme` script if the pack owns them, its regexes and the registry.

It never touches `stat_data`, the card's `mvu` script, any other entry, or the library copy. Same as uninstalling a game on a console. Your save file stays.

## Export

Export rebuilds the pack file from the card. The card's copies are what it ships, so an edit you made on the card goes into the export.

It refuses when a piece the install recorded is missing. The result goes through the same checks as an import.

[Back to How a GameLogic Engine works](technical.md) · [Back to index](../../README.md)
