# Install, uninstall and mismatch

> This page applies to any game. ArtificKoi shows up as a real example, not as a rule. See [A general design, with one real example](../gamelogic_engine/technical.md#a-general-design-with-one-real-example).

A StatusMenu Pack goes into the library first, and from the library onto a card. Both happen on its own tab, StatusMenu Packs. One menu per card.

## Import and install

- **The single file:** Import > paste it or Load file > Validate > Add to library.
- **The folder:** Import source folder, or Import source ZIP. Or let the dev loop do it, see [Development Environment and Dev Loops](../dev_env/README.md).

Then Install to this card on its library row.

Its row in On this card reads **Pieces missing** when one of its pieces is gone, the engine included. If something else replaced the engine, such as a StatusMenu Engine dev upload, the row gets a **Drift** pill naming it. Repair writes the pack's copy back.

**Installing the regexes reloads the chat.** Regexes are only written at install, not on every save.

## What install writes

These entries in the card's own lorebook, all of them silent (disabled, no keys), so nothing here ever reaches a prompt:

```
[StatusMenuPack:<id>] (Layout)          the whole layout
[MVU_StatusMenuEngine]                  the engine text, when the pack ships one
[MVU_StatusMenuBody:<script_name>]      one lifted page, for every regex that carried one
[StatusMenuPack:Registry]               what this pack owns
```

Plus the pack's regexes, each written with its page lifted out. See [Where the menu runs](frame.md#the-shell-is-lifted-out-of-tavern-helpers-hands).

**An engine it doesn't own is never overwritten.** If the card already has a Status Menu Engine that no install of this pack wrote, an install that ships an engine is refused.

A pack that ships no regexes never touches the card's regexes at all.

## Uninstall

The registry is the record of what the pack owns, and uninstall removes exactly that: its entries, its own engine, its lifted pages and its own regexes by name. Then it double-checks for anything left with the pack's name on it, and reports a mismatch instead of leaving it behind.

It never touches the GameLogic Pack, the MVU script, or any entry it didn't write. Your save stays.

**Export puts it all back.** Export rebuilds the pack file from the card, and puts every lifted page back into its regex, byte for byte. Export what you installed, and you get the same file back.

## A wrong menu never breaks a card

A menu is drawn for one game, and nothing checks the pairing. `targetsPackId` is only a label.

So install a menu on a card whose game doesn't match, and the menu still draws. A variable path that doesn't exist, a cell type it doesn't know, a formatter the engine doesn't export, a lorebook key that finds nothing: each one shows raw or empty, and logs ONE warning naming what it couldn't find.

That's the whole compatibility story. A pack must never be able to break the menu, and a wrong pairing should LOOK obviously wrong, instead of looking like a broken game.

## The smallest pack that works

```json
{
  "format": "1.0",
  "packType": "statusmenu",
  "id": "my-menu",
  "name": "My menu",
  "description": "A status menu for my game.",
  "version": "1.0",
  "engine": "// my-menu StatusMenu Engine\nconst ENGINE_VERSION = 'v1.0';\nmodule.exports = { ENGINE_VERSION, formatters: {}, actions: {} };",
  "layout": { "kind": "tabbed-grid", "format": "1.0", "tabs": [] }
}
```

It installs, and draws an empty menu. Everything else is what you draw in the builder.

[Back to How the Status Menu Engine works](technical.md) · [Back to index](../../README.md)
