# Where the menu runs

> This page applies to any game. ArtificKoi shows up as a real example, not as a rule. See [A general design, with one real example](../gamelogic_engine/technical.md#a-general-design-with-one-real-example).

The menu is a web page, and a web page on the SillyTavern page could do anything SillyTavern can. So MVU Helper never lets it sit there. It runs the menu in a locked frame of its own, and hands it only what a menu needs.

## The layout is pure data

`layout/layout.json` is what the menu draws: tabs, blocks, cells, lists, buttons. MVU Helper asks one thing of it: no `customLogic`, anywhere inside. Logic lives in the engine, reached by name.

So a layout can be edited by hand, and there's no code hiding in it.

Everything else inside the layout belongs to the renderer, the builder's menu runtime. MVU Helper stores it as it is and never reads it. Install writes it whole into one entry, `[StatusMenuPack:<id>] (Layout)`.

## The shell is lifted out of Tavern Helper's hands

`regex/StatusMenu.json` is a regex whose replacement is a whole web page, the menu shell. Tavern Helper renders a page like that with full access to your SillyTavern page. So install never writes it that way.

Install lifts the page out:

1. The page moves into its own silent entry, `[MVU_StatusMenuBody:<script_name>]`.
2. The regex is written back as an empty container, so Tavern Helper has nothing to render.
3. MVU Helper mounts the page in its own locked frame, in that container.

For that to work, the replacement has to be exactly what the builder exports: a container `<div … data-mvu-helper="<region>">`, a `<!-- mvu-helper:begin <region> -->` and `end` pair inside it, ONE code fence between them, and nothing else but comments.

The install is refused, naming the regex, when a regex would still carry `html>`, `<head>` or `<body` after the lift, when a fence sits outside a container, when a container holds 2 fences, or when a fence is empty. A pack can ship several pages like that, each in its own region. ArtificKoi ships 2: the menu, and its game start screen.

## The locked frame

The frame is a sandbox with no same-origin access. In plain words:

- **It can't see the SillyTavern page.** Reading anything on `window.parent` or `window.top` throws an error.
- **No cookies, no storage, no network.** `connect-src` is `'none'`.
- **No outside code.** A `<script src>`, `import()` or `eval` is refused. Only inline script and style run.
- **Images** come from `data:` and `blob:`, plus the image sources you allow in MVU Helper's Main tab (by default `http:` and `https:`).

It's like a shop window. People can see in, and the shop can hand things out through a slot, but nobody walks through the glass.

**A menu that reads `window.parent` outside a `try` dies at that line.** MVU Helper won't move it back onto the page to make it work. It warns, naming the `SecurityError` and the fix. Every builder export from 2.5.2 on reads its own window first.

## What the menu can ask for

The menu talks to MVU Helper by message, and only these:

| The menu asks for | MVU Helper answers with |
| --- | --- |
| the formatters' values | the cells' values, and the names it couldn't find |
| running an action | the result. A landed action also pushes the new state to the menu |
| an action's inputs | the questions to ask, see [Inputs](engine.md#inputs-when-a-button-has-to-ask-first) |
| one lorebook entry's content | that entry's text, matched by its keys or its comment |
| a SillyTavern image | the image as a `blob:`. Only from SillyTavern itself, never from `/api/`, and only an image |
| opening a link | the page opens it in a new tab. Only `http(s)`, only right after a click |

The menu also reports its height, when a popup opens or closes, and any error it hits.

**Why images go through MVU Helper:** SillyTavern sends every file with `Cross-Origin-Resource-Policy: same-origin`, so a locked frame can't load a SillyTavern image directly. MVU Helper reads it on the page and hands it over as a `blob:`.

**Why links go through MVU Helper:** the frame can't open a tab itself, and following a link inside the frame would replace your menu with that website. A link the menu handles itself, and an in-page `#anchor`, stay the menu's.

## The menu never has to poll

MVU Helper pushes the state to the menu whenever it changes:

- every time the frame loads,
- when MVU is ready, since on a page load the menu can mount before MVU exists,
- after every MVU update,
- after every save MVU Helper makes: the turn's RES1 and RES2, a landed action, the PRE patch,
- and within 2 seconds of an edit nothing announced, like Tavern Helper's variable editor, or another script's `Mvu.replaceMvuData`.

For that last one, MVU Helper compares the variables with what it sent last, and skips them when nothing changed. So an idle chat sends nothing.

## What a builder menu can call

A small prelude runs before the menu, and answers the calls a builder menu makes from the pushed state:

- `getCurrentMessageId`, `getVariables`, `waitGlobalInitialized`,
- `Mvu.getMvuData`, and `Mvu.events.VARIABLE_UPDATE_ENDED` with `eventOn`,
- `_.get` and `_.set`,
- an in-memory `localStorage`,
- `MvuHelperFrame.lorebookContent(key)`.

**Popups.** While a popup is open, the frame is lifted over the whole screen, over SillyTavern's top bar and send box. Closing it is the menu's job. MVU Helper adds no Escape key and no click-outside close.

**Macros.** `{{user}}` and the like are filled in when the menu mounts, the same way SillyTavern's regexes fill them in. `{{match}}` and `$1` aren't, because a mounted page replaces no match.

[Back to How the Status Menu Engine works](technical.md) · [Back to index](../../README.md)
