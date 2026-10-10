# Import, install and uninstall

Your pack goes into the library first, and from the library onto a card. Everything happens on the GameLogic Packs tab.

## Start from the skeleton

GameLogic Packs tab > Add New Blank Packs > type GameLogic Pack > Create archive.

The ZIP holds a `gamelogic/` folder with a working minimum: `pack.json`, an engine that exports `resolveTurn`, a disabled example entry, a sample regex and a sample schema. Extract it at your workspace root.

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

Every door judges a pack the same way: the format rules and the source checks. See [Checks on every import](pack.md#checks-on-every-import). An event pack in a folder or ZIP goes to the Event Packs tab's own library instead.

## Install, Repair, Upgrade, Downgrade

On the library row: Install to this card.

The On this card row then offers Export and Uninstall. Repair shows up when pieces are missing from the card, and Upgrade when the library holds a newer version.

The pack's `version` decides which one it is. Same version is Repair, newer is Upgrade, older is Downgrade, and Downgrade asks first.

All 4 write the same way:

1. Every entry the previous install recorded is deleted, then the pack's entries are written.
2. The engine goes into `[MVU_LogicEngine]`, the schema into the `Scheme` script, and the regexes into the card's regex list. Regexes an older version installed and this one no longer ships are removed.
3. `[GameLogicPack:Registry]` records what was written and owned, the `state`, the `exposes` map and the pack's identity.
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
