# How the Status Menu Engine works

> This page applies to any game. ArtificKoi shows up as a real example, not as a rule. See [A general design, with one real example](../gamelogic_engine/technical.md#a-general-design-with-one-real-example).

A StatusMenu Pack has 3 pieces. The layout is data: what the menu draws. The engine is code: what each cell shows and what each button does. The shell is the page that puts it all on screen.

The builder writes most of it. This page is about which file is whose, and what to export when.

## The technical pages

1. [The menu engine](engine.md) > formatters, actions and inputs, and the 2 engine files.
2. [Where the menu runs](frame.md) > the layout, the shell, and the locked frame the menu runs in.
3. [Install, uninstall and mismatch](install.md) > what install writes, and why a wrong menu never breaks a card.

## The folder

| File | Written by | What it is |
| --- | --- | --- |
| `pack.json` | the builder, once. Yours after that | the pack's name card, see below |
| `layout/layout.json` | the builder, on every export | the layout: tabs, blocks, cells, lists, buttons. Pure data |
| `engine/layoutFormatters.cjs` | the builder, on every export | the formulas behind your cells. Never edit it |
| `engine/statusMenuLogic.cjs` | the builder once, as a starter. Yours after that | your menu logic: actions, inputs, and any formatter you write by hand |
| `regex/StatusMenu.json` | the builder, on every export | the menu shell, the page that draws the layout |
| `regex/regex-order.json` | you | every regex's `script_name`, in the order they apply |

You can add regexes of your own next to the shell. ArtificKoi adds `_GameStartMenu__.json`, its game start screen, and lists it in `regex-order.json` before the shell.

The template workspace's `statusmenu/` is ArtificKoi's real menu. See [The template workspace](../gamelogic_engine/install.md#the-template-workspace).

## pack.json

ArtificKoi's:

```json
{
  "format": "1.0",
  "packType": "statusmenu",
  "id": "artifickoi",
  "name": "ArtificKoi",
  "description": "ArtificKoi",
  "version": "1.5",
  "builtWith": "MvuStatMenuBuilder 2.5.2",
  "engineOrder": ["layoutFormatters.cjs", "statusMenuLogic.cjs"],
  "targetsPackId": "school-v4"
}
```

| Field | Required | What it does |
| --- | --- | --- |
| `format` | yes | the pack format. MVU Helper understands `"1.0"` |
| `packType` | yes | always `"statusmenu"` |
| `id` | yes | lowercase with dashes. It names the menu's styles and its lorebook entries, so keep it the same once you publish. `registry` is reserved |
| `name`, `description` | yes | shown on its library row |
| `version` | no, but warned | 2 or 3 whole numbers. Install compares it to tell an upgrade from a reinstall |
| `builtWith` | no | which tool made it. Stored, never read |
| `engineOrder` | yes, with an engine | the engine files in the order they load |
| `targetsPackId` | no | the GameLogic Pack the menu was drawn for. A label only, never checked |

A StatusMenu Pack can't carry `schema`, `state`, `exposes`, `requires` or `optionalUses`. Those belong to other pack types, and the pack is refused if it has them.

**One folder per id.** 2 folders with the same id overwrite each other in the library, and then drift apart as you edit one of them.

## The builder's exports

The StatusMenu Pack tab in MVU Status Menu Builder has 3 exports. Before you use any of them, fill in the pack's identity on the same tab: name, id, description, version, and which builder tabs go into the pack.

| Button | You get | What's inside | Where it goes |
| --- | --- | --- | --- |
| Download `<id>-statusmenu-pack.json` | one file | the layout, a starter engine and the shell, all in one | MVU Helper > GameLogic Packs tab > Import. The shipping file |
| Bootstrap workspace .zip | `statusmenu.zip` | `pack.json`, the layout, both engine files and the shell | extract into an EMPTY `workspace/statusmenu/`, once |
| Refresh .zip (layout + shell) | `statusmenu-refresh.zip` | the layout, `layoutFormatters.cjs` and the shell | extract into `workspace/statusmenu/`, any time |

**Copy pack JSON** copies the same file as the download, to paste into MVU Helper's Import box.

**The bootstrap only goes into an empty folder.** It carries a starter `statusMenuLogic.cjs`, so over a folder you already work in, it replaces your logic.

**The refresh is always safe.** It never carries `statusMenuLogic.cjs` or `pack.json`, so it can go over work in progress.

MVU Helper's own GameLogic Packs tab > Add New Blank Packs > StatusMenu Pack gives you the same 2 engine files too, with an empty `layoutFormatters.cjs` until your first refresh fills it.

## When the layout changes

A new cell, a new formula, a new tab:

1. Change it in the builder.
2. Export **Refresh .zip (layout + shell)**, and extract it into `workspace/statusmenu/`.
3. The dev loop picks it up, and the menu on the card redraws.

A cell that names a formatter the engine doesn't export is an error, and it names the cell.

Your `statusMenuLogic.cjs` only changes for what the builder can't write: an action, its inputs, or a formatter you write by hand. How to write those is on [The menu engine](engine.md).

Basically, the builder owns how the menu looks, you own what it does, and the refresh export keeps those 2 apart.

[Back to What is Status Menu Engine](README.md) · [Back to index](../../README.md)
