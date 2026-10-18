# How the side panel works

> This page applies to any card. ArtificKoi has no slot yet, so the real example here is the `plugin-standalone-probe` sample from the [template workspace](../gamelogic_engine/install.md#the-template-workspace).

A slot is one JSON declaration. MVU Helper reads it, points each row at a value in `stat_data`, and draws the result. This page is the whole format, and what MVU Helper does with every key.

## What's on this page

1. [Where the file goes](#where-the-file-goes) > `panel/panel.json`, and what install does with it.
2. [When it redraws](#when-it-redraws) > which events, which message.
3. [The smallest slot](#the-smallest-slot) > 10 lines that work.
4. [The top level and tabs](#the-top-level-and-tabs) > `kind`, `format`, `title`, `tabs`.
5. [Blocks](#blocks) > `fields`, `heading`, `collection`, and a collection inside a collection.
6. [Paths](#paths) > the 3 forms, what a value looks like, and what a miss looks like.
7. [Colors](#colors) > `style`, hex only, gradients, rules that change a color with the value.
8. [Caps](#caps) > how much a slot can hold.
9. [Computing a slot instead](#computing-a-slot-instead-renderpanel) > `renderPanel`, and when to bind or compute.
10. [What warns, and what refuses](#what-warns-and-what-refuses) > every warning, and the one refusal.
11. [The probe, tab by tab](#the-probe-tab-by-tab) > the working example.

## Where the file goes

| Your artifact is | The declaration goes |
| --- | --- |
| a folder (the dev loop, the template workspace) | `panel/panel.json`. That exact name, and nothing else in `panel/` |
| a single JSON file | the top-level `"panel"` object |

A GameLogic Pack and a GameLogic Plugin can have one. A StatusMenu Pack can't, it already owns a whole screen.

Install writes it onto the card as a disabled entry: `[GameLogicPack:<id>:Panel]` or `[GameLogicPlugin:<id>:Panel]`. The AI never reads it. Uninstall removes it, and the dev loop writes it again every time you save `panel.json`.

No `panel`, no slot, and no warning either. Most artifacts don't need one.

## When it redraws

The panel redraws whenever the state may have changed:

- MVU's update event, after every parse,
- every save MVU Helper makes itself, which MVU announces nowhere,
- a reply arriving, a message edited, a swipe, a chat change.

The redraws are grouped, 300 milliseconds apart at most, so a turn with 5 writes draws once.

It always reads the latest message, on the swipe you're looking at. So swipe back, and the panel shows that swipe's numbers.

## The smallest slot

This is a complete `panel.json` for a GameLogic Pack:

```json
{
  "kind": "slot-list",
  "format": "1.0",
  "title": "Weather",
  "tabs": [
    { "id": "now", "name": "Now", "blocks": [
      { "type": "fields", "fields": [
        { "label": "Time",    "path": "World.Time" },
        { "label": "Weather", "path": "World.Weather" }
      ] }
    ] }
  ]
}
```

A slot titled "Weather", with 2 rows. In a pack, a bare path reads from the top of `stat_data`, so `World.Time` is `stat_data.World.Time`. One tab shows no tab strip at all.

## The top level and tabs

| Key | Required | What MVU Helper does with it |
| --- | --- | --- |
| `kind` | yes | must be `"slot-list"`. Anything else skips the slot quietly, so a later kind can ship without breaking an old MVU Helper |
| `format` | yes | `"1.0"` |
| `title` | no | the slot's name in its header. Falls back to the artifact's id |
| `tabs` | yes | the tabs, in order. One tab draws no tab strip |

Each tab has:

- **`id`**, which stays the same. The panel remembers the open tab by it.
- **`name`**, what the tab strip shows. Falls back to `id`.
- **`blocks`**, what's on the tab, top to bottom.

## Blocks

A tab is a stack of blocks. There are 2 kinds.

### `fields`: plain rows

```json
{ "type": "fields", "fields": [ { "label": "Energy", "path": "Energy" } ] }
```

One row per field: the `label`, then the value at `path`. No `label`, and the path is the label.

### `heading`: a band over any block

Any block can carry a `heading`. It's a full-width band above the block, so several unrelated rows can sit under one name:

```json
{ "type": "fields", "heading": "WORLD",
  "style": { "heading": { "color": "#dfe7ff",
                          "background": { "stops": ["#2a1a4a", "#1a2f4a"], "angle": 100 } } },
  "fields": [ { "label": "Time", "path": "$.World.Time" } ] }
```

It's called `heading` and not `title` on purpose. `title` names the whole slot. One word for 2 levels would teach the wrong one.

### `collection`: one group per key

```json
{ "type": "collection", "path": "Characters",
  "fields": [ { "label": "Outfit",      "path": "Outfit" },
              { "label": "Recorded at", "path": "RecordedAt" } ] }
```

`path` points at a map, like `{ "Mitsuki": {…}, "Mana": {…} }`. Every key becomes a group with its name on top, and the `fields` are read inside each one.

Use it whenever you can't know the keys when you write the file: characters, hobbies, inventory. You never write "Mitsuki" anywhere, and a classmate who joins next week shows up by herself.

An array is not a collection. `path` has to land on an object. A collection that lands on nothing, an array or a single value draws `—` and warns.

### A collection inside a collection

A `collection` can carry `blocks` as well as `fields`. That's how you show every classmate, and each one's belongings under her name, without naming anyone:

```json
{
  "type": "collection",
  "path": "{cast@1}",
  "style": { "groupKey": { "color": "#e08ac0" } },
  "fields": [ { "label": "Mood", "path": "Mood" } ],
  "blocks": [
    {
      "type": "collection",
      "path": "Belongings",
      "style": { "groupKey": { "color": "#9ecbff" } },
      "fields": [
        { "label": "Type", "path": "Type" },
        { "label": "Qty",  "path": "Qty" }
      ]
    }
  ]
}
```

```
Mitsuki                  <- level 1
  Mood        Happy
  CookieTin              <- level 2, under her name
    Type      Personal Item
    Qty       1
  RecipeNotebook
    Type      Notebook
    Qty       1
Mana
  Mood        Calm
  ...
```

- A group's own `fields` come first, then its `blocks`. Always that order.
- A bare path in a nested block reads inside its own group. So `Belongings` is Mitsuki's belongings, then Mana's.
- `$.` and `{token}` paths don't follow the nesting. They always read from where they say.
- `style.groupKey` belongs to each level, and judges that level's key.
- 3 levels at most. A 4th is dropped, with one warning that names where: `tab "Belongings" · Mitsuki · CookieTin: nested blocks below depth 3 are not rendered`. The levels above still draw.

### Anything else

A block with a `type` MVU Helper doesn't know is skipped, with no warning. A later format may add types, and an old MVU Helper shouldn't complain about every one of them on every redraw.

## Paths

A path is dotted, like `World.Time`. How it starts says where it reads from:

| Form | Reads from | Use it for |
| --- | --- | --- |
| `RelayTurn` | your own scope, see below | everything your artifact writes itself |
| `{cast@1}.Mitsuki.Hobbies` | the game path an interface points at | reading the game you sit on, on any game. You never spell its names |
| `$.World.Time` | the top of `stat_data`, raw | you know THIS card's layout, and say so |

What "your own scope" means depends on what you are:

| Artifact | A bare path reads from |
| --- | --- |
| GameLogic Pack | the top of `stat_data` |
| GameLogic Plugin | your own drawer, `GameLogicPlugin.<your drawer name>` |

That's why a plugin's panel works whatever drawer name the player picked at install.

A plugin's `{token}` only works for an interface it declared in its `pack.json`, in `requires` or `optionalUses`. A pack sees every interface it exposes. `$` alone is the top of `stat_data`, and `{cast@1}` alone is the whole thing the interface points at. What interfaces are is on [Running on any game](../gamelogic_plugin/any_game.md#where-does-this-game-keep-it).

### What a value looks like

- An MVU pair, `[value, "Label"]`, shows its value. Only that exact 2-slot shape. Any other list is data.
- An object shows as `{N keys}`. A list shows its items joined with `, `. Use a `collection` to show what's inside.
- A value over 400 characters is cut with `…`.

### When a path finds nothing

The row shows a dim `·`, and the console warns once per path per chat. The slot still draws.

There are 2 different mistakes, so there are 2 different warnings:

```
path "Nope" resolved to nothing
token "{cast@9}" is not exposed by the active pack — nothing to read
```

The first one is a typo, or a value your game hasn't written yet. The second one is an interface the game doesn't have.

## Colors

A row has 3 parts you can paint: the **label**, the **value**, and the **row** behind both. The colors go under `style`, right next to the path they paint.

```json
{ "label": "Energy", "path": "Energy", "style": {
    "label": { "color": "#888888" },
    "value": { "color": [ { "lt": 20, "use": "#dd6a6a" },
                          { "lt": 50, "use": "#d3a03c" },
                          { "use": "#5cb37a" } ],
               "background": "#2a1414" },
    "row":   { "background": [ { "lt": 20, "use": "#180000" } ] } } }
```

That's Energy in red below 20, amber below 50, green above. Its row goes dark red below 20 too. The label is always grey.

The same grammar works everywhere:

```
style  ->  { <part>: paint }
paint  ->  { "color": colour, "background": colour }
colour ->  "#rrggbb"  |  [ rule, rule, … ]
rule   ->  { <conditions…>, "use": "#rrggbb" }
```

### What each place can paint

| Declared on | Parts | The rules judge |
| --- | --- | --- |
| a field | `label`, `value`, `row` | that row's value |
| a `fields` block | `heading` | the heading's text |
| a `collection` block | `heading`, `groupKey` | `heading` its text, `groupKey` each group's key |

All 3 parts of a row judge the same value. That's what lets a low stat paint its own label red.

A group's name has no field of its own, so the block paints it:

```json
{ "type": "collection", "path": "{cast@1}",
  "style": { "groupKey": { "color": [ { "eq": "Mitsuki", "use": "#e08ac0" }, { "use": "#888888" } ] } },
  "fields": [ { "label": "Outfit", "path": "Outfit" } ] }
```

A part a place can't paint is reported, with the list it can: `tab "Lane" — "Energy": unknown cell "groupKey" (this one paints: label, value, row)`.

### Hex, and only hex

`#rgb`, `#rrggbb`, and the same with opacity, `#rgba` and `#rrggbbaa`. The last digit or pair is opacity, `00` invisible up to `ff` solid.

Not `red`, not `rgb(1,2,3)`, not a SillyTavern theme variable. Whatever you write ends up in the page's styles, so only a plain color gets through. Anything else is reported, never dropped quietly: `"tomato" is not a hex colour`.

MVU Helper has no colors of its own. They're yours, and so is the catch: a hex color doesn't follow the player's SillyTavern theme. A color picked on a dark theme can be hard to read on a light one, and the panel can't tell.

### Gradients

A `background` can be a gradient, written as an object:

```json
"background": { "stops": ["#2a1a4a", "#1a2f4a"], "angle": 100 }
"background": { "stops": ["#4a2a1a", "#4a3a1a", "#2a1a10"] }
```

- 2 to 6 stops, each one a hex color. `angle` is in degrees, 90 when you leave it out.
- Backgrounds only. Text can't take a gradient, and asking for one is reported.
- It works anywhere a color does, inside a rule's `use` too.

It's an object for a reason. A string is already a hex color, and a list is already a list of rules, so a gradient needs a shape of its own.

### See-through

Nothing new needed. A part with no `background` has none. And `#7ea6e022` is that blue at 13%, a faint wash over whatever is behind it:

```json
{ "label": "Time", "path": "$.World.Time", "style": { "value": { "background": "#7ea6e022" } } }
```

### Rules: a color that changes with the value

| Condition | Matches when | Notes |
| --- | --- | --- |
| `lt` | value `<` it | a number |
| `lte` | value `<=` it | a number |
| `gt` | value `>` it | a number |
| `gte` | value `>=` it | a number |
| `eq` | the value's text is exactly it | case matters |
| `has` | the value's text contains it | case doesn't matter |
| `is` | the value is true, or false | `true` or `false` |
| *(none)* | always | the default. Put it last |

How a rule list is read:

1. **Top to bottom, and the first match wins.** The rest aren't looked at.
2. **Every condition in one rule must hold.** `{ "gte": 10, "lt": 20, "use": "#d3a03c" }` is the 10 to 19 band, in one rule.
3. **A rule with no condition always matches.** So it's the default, and anywhere but last, every rule after it is dead.
4. **A number test needs a real number.** `""`, `null`, `false` and `[]` are NOT zero, so an empty stat never paints itself red. A number written as text, like `"12"`, does count.
5. **An MVU pair is judged by its value.** `[12, "Energy"]` is tested as `12`.
6. **A row that found nothing is never painted,** not even its fixed colors. Every rule judges a value, and there's none.

3 more you can copy:

```json
"style": {
  "value": { "color": [ { "is": true, "use": "#ffd24a" }, { "use": "#888888" } ] },
  "row":   { "background": [ { "is": true, "use": "#3a2c05" } ] }
}
```

A true/false flag that lights up its whole row when it's true.

```json
"style": { "value": { "color": [ { "eq": "Lover",   "use": "#e08ac0" },
                                 { "has": "friend", "use": "#5cb37a" },
                                 { "use": "#888888" } ] } }
```

A text state: pink for exactly "Lover", green for anything with "friend" in it, grey for the rest.

```json
"style": { "row": { "background": [ { "lt": 20, "use": "#180000" } ] } }
```

No default arm, so the row is only painted below 20, and left alone above it.

## Caps

A panel is something you glance at. So anything over a cap is dropped, not scrolled forever:

| Cap | Limit |
| --- | --- |
| tabs per slot | 8 |
| blocks per tab | 8 |
| rows per block | 64 |
| groups per collection | 64, per level |
| characters per value | 400 |
| rules per color | 8 |
| gradient stops | 6 |
| collections inside collections | 3 levels |

## Computing a slot instead: `renderPanel`

Your engine can export `renderPanel(ctx)` and work out the whole slot itself. When it does, its answer replaces your declaration for that slot. So it has to return every tab, not just one extra.

```js
renderPanel({ ownState, snapshot, engine, exposes }) {
    return {
        title: 'Weather',
        tabs: [ { id: 'now', name: 'Now', blocks: [
            { type: 'fields', rows: [ { label: 'Time', value: '07:30' } ] },
        ] } ],
    };
}
```

- **`ctx`** is `resolveRelay`'s read side without the reply fields: your drawer, the whole `stat_data`, the game's identity, and your interfaces matched to this game. A redraw is not a turn, so there's no `ops`, `mid` or `swipe`.
- **It returns values, not paths.** You already have the state in hand. A `fields` block has `rows: [{ label, value, style }]`, and a `collection` has `groups: [{ key, style, rows, blocks }]`.
- **`heading`, `style` and the caps work the same,** with the same checks. The one difference: a computed group paints its own key, on `groups[].style.groupKey`, because your code builds each group.
- **Text only.** Every value is shown as text. Markup is never accepted.
- **You still need `panel.json`.** The slot only exists when the declaration does. And it's what draws instead when `renderPanel` throws or returns something that doesn't fit, with a warning.

### Bind it, or compute it?

**Bind it in `panel.json` when it's a plain read.** No code, and nothing to go stale.

**Compute it when the value has to be joined, counted, compared, or found by going through keys** nobody can name in advance. A declaration names a fixed path. It can't count, and it can't pick.

There's a third way, and it's the one the probe uses: work the value out in `resolveRelay`, write it into your own drawer, and bind that. The value is then saved with the reply. It survives a reload, and it follows a swipe. Use it when the value belongs to the turn, like "what the last reply did". Use `renderPanel` when it's just a different way of showing what's already there.

## What warns, and what refuses

| What happened | What MVU Helper does |
| --- | --- |
| the panel entry isn't JSON, or isn't an object | the slot is skipped, with the parse error. The one refusal |
| `kind` isn't `slot-list` | the slot is skipped, quietly. Nothing is broken |
| a path finds nothing | the row shows `·`, one warning per path per chat |
| a token the game doesn't expose | the same, with the token named |
| a collection path is missing, or lands on an array or a single value | the block shows `—`, one warning |
| a block `type` it doesn't know | skipped, no warning |
| collections nested past 3 levels | dropped, one warning for that block. Every level above draws |
| a part a place can't paint | reported, with what that place can paint |
| a color that isn't hex | reported, with the field and what you wrote |
| a gradient with bad stops, too few, too many, or on text | reported, and that part isn't painted |
| `renderPanel` returns junk, or throws | warned, and the slot draws from `panel.json` instead |

Every warning shows up once per chat, however often the panel redraws. They print as `[mvu-helper] [side-panel] "<id>" …`, so you know which slot said it. A warning from `renderPanel` starts with `renderPanel`, so you know which lane said it.

## The probe, tab by tab

`plugin-standalone-probe` is a standalone plugin, and its [panel.json](https://github.com/KritBlade/mvu-helper/blob/mvu-helper-template/workspace/plugin-standalone-probe/panel/panel.json) uses every feature on this page. Install it on any card, play a few replies, and open the drawer.

| Tab | What it shows |
| --- | --- |
| **Color** | 3 blocks, each under a gradient `heading`: the WORLD from `$.World…`, the LANE from its own drawer, and the CAST through `{cast@1}`. Every value sits on a faint see-through wash |
| **Wardrobe** | a `collection` over its own drawer's `Characters`: what each character is wearing. Its POST call reads it off the story, and its `resolveRelay` turns that into one group per character |
| **Foreign** | the 2 ways to read state you don't own, side by side. `$.World.Time` and `{cast@1}.Mitsuki.Hobbies` bound in `panel.json`, next to `ExampleWorldTime` and `ExampleHobbies`, worked out in its `resolveRelay` and bound from its drawer |
| **Belongings** | a collection inside a collection: every classmate through `{cast@1}`, her Affection colored in 3 bands, and her `Belongings` under her name |
| **Lane** | rules on numbers, a true/false flag lighting its whole row, a `has` rule on text, and a grey label |

The probe has no `renderPanel`. Its computed values come from `resolveRelay`, the third way above, and the commented walkthrough is in its `engine/relay-resolver.cjs`.

On a card with no game, the `{cast@1}` rows show the "missing" marker, and its own drawer still fills in. That's the point of binding your own drawer for everything that has to show on any card.

Basically, `panel.json` says which value goes in which row and what color it is, and MVU Helper reads the save and draws it, every time the state changes.

[Back to Side Panel](README.md) · [Back to index](../../README.md)
