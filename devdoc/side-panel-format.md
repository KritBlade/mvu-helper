# Side panel format — what mvu-helper renders

Audience: anyone writing a **panel declaration** — the `panel` section of a GameLogic Pack or a
GameLogic Plugin. This document is the HOST's side of the contract: the keys mvu-helper reads, what it
draws for each, and what it refuses. Plan/spec: `plans/executed/plugin-sidepanel.md` §3.

A declaration buys one **slot** in mvu-helper's side panel: a docked drawer behind the chevron at the
right edge of the chat, one slot per declaring artifact, each collapsible, ordered by the
`sidePanel.order` setting with ↑/↓ arrows on each slot header. The panel re-renders whenever the state may
have changed (MVU's update event, every state save mvu-helper makes, and the message events), reads the
latest message's current swipe, and hides entirely on a card whose artifacts declare nothing. The panel is
opt-in: no `panel`, no slot, no warning.

The declaration is DATA, never code. It binds to `stat_data` and parses no prose.

---

## 1. Where it lives, and who may declare one

| Source form | Where the declaration goes |
| --- | --- |
| folder (dev loop / workspace) | `panel/panel.json` — that exact name, nothing else in `panel/` |
| single JSON file | the top-level `"panel"` object |

`panel` is accepted on **`gamelogic`** and **`plugin`** artifacts. A StatusMenu Pack may not declare
one — it already owns a whole rendering surface.

Install writes the declaration onto the card as a silent, disabled `[<type>:<id>:Panel]` lorebook
entry (a section entry inside the installer's own prefix, so no author entry can collide with it);
uninstall sweeps it; the dev loop's `panel/` sink hot-reloads it.

---

## 2. The whole shape

```jsonc
{
  "kind": "slot-list",          // the one renderer kind this build draws
  "format": "1.0",
  "title": "Standalone Probe",  // the slot's heading
  "tabs": [
    {
      "id": "lane",             // stable id — the panel remembers the open tab by it
      "name": "Lane",           // what the tab strip shows
      "blocks": [
        {
          "type": "fields",     // flat label/value rows
          "heading": "LANE",    // an optional band over this block (§3)
          "fields": [
            { "label": "Relay turn", "path": "RelayTurn" },
            { "label": "Time",       "path": "$.World.Time",
              // #rrggbbaa — the last pair is opacity, so this is a 13% wash (§5)
              "style": { "value": { "background": "#7ea6e022" } } }
          ]
        },
        {
          "type": "collection", // a MAP: one group per key, each rendering the same fields
          "path": "{cast@1}",
          "style": { "groupKey": { "color": "#e08ac0" } },
          "fields": [
            { "label": "Outfit", "path": "Outfit" }
          ]
        }
      ]
    }
  ]
}
```

**Top level**

| Key | Required | What the host does |
| --- | --- | --- |
| `kind` | yes | Must be `"slot-list"`. Any other value SKIPS the slot with the kind named — not an error, so a future kind ships without a host change. |
| `format` | yes | `"1.0"`. Carried; the host reads `kind` and `format` and nothing else at this level. |
| `title` | no | The SLOT's name, shown in its header. Falls back to the artifact id. A block's own band is `heading` (§3) — a different key, a different level. |
| `tabs` | yes | The tabs, in order. One tab renders with no tab strip. |

**A tab**: `id` (stable — the open tab is remembered per slot), `name` (falls back to `id`), `blocks`.

---

## 3. Blocks

### `fields` — flat rows

```jsonc
{ "type": "fields", "fields": [ { "label": "Energy", "path": "Energy" } ] }
```

One row per entry: the `label` cell, then the value read at `path`. `label` falls back to the path.

### `heading` — a band over any block

Any block may carry a `heading`, and it paints like every other cell. This is what lets several
unrelated fields sit under one band — without it, a heading could only ever be a collection KEY.
It is NOT called `title`: the top-level `title` names the whole SLOT, and one word for both levels is
a word that teaches the wrong one.

```jsonc
{ "type": "fields", "heading": "WORLD",
  "style": { "heading": { "color": "#dfe7ff",
                        "background": { "stops": ["#2a1a4a", "#1a2f4a"], "angle": 100 } } },
  "fields": [ { "label": "Time", "path": "$.World.Time" } ] }
```

The band renders full width above the block's content. Its rules judge the HEADING TEXT — the only
value a heading has, the same stance `groupKey` takes with its key. A block with no `heading` renders
none, exactly as before.

### `collection` — one group per key

```jsonc
{ "type": "collection", "path": "Characters",
  "fields": [ { "label": "Outfit", "path": "Outfit" },
              { "label": "Recorded at", "path": "RecordedAt" } ] }
```

`path` names a MAP (`""` is the scope itself). Each key becomes a group heading, and the group's rows
are this block's `fields` read **relative to that child**. Use it whenever the keys are not knowable
when you write the declaration — characters, hobbies, inventory.

An array is not a collection: `path` must land on an object. A collection whose path resolves to
nothing, or to an array or a scalar, renders `—` and warns; it never refuses the slot.

### Nesting — a collection inside a collection

A `collection` may carry `blocks` as well as `fields`, and a nested block's bare paths are relative to
its own group's child. That is what makes "every classmate, and each one's belongings" expressible
without naming a classmate:

```jsonc
{
  "type": "collection",
  "path": "{cast@1}",                                    // level 1 — one group per classmate
  "style": { "groupKey": { "color": "#e08ac0" } },
  "fields": [                                            // rows on the classmate itself
    { "label": "Outfit", "path": "Outfit" }
  ],
  "blocks": [
    {
      "type": "collection",
      "path": "Belongings",                             // level 2 — relative to THIS classmate
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
Mitsuki                  <- level 1 key
  Outfit      vest
  CookieTin              <- level 2 key, indented under its group
    Type      Personal Item
    Qty       1
  RecipeNotebook
    Type      Notebook
    Qty       1
Mana
  Outfit      coat
  ...
```

- A group's own `fields` render FIRST, then its `blocks` — one order, never a guess.
- Drop `fields` and the level renders only its nested blocks; drop `blocks` and it is the flat
  collection this format always had. Neither key is required.
- `style.groupKey` is per level, judged against that level's key.
- `$.` and `{token}` stay ABSOLUTE at any depth — only bare paths follow the nesting.
- Depth is capped at **3** collection levels. A declaration that nests past it is told so ONCE per
  block and the levels above still render:
  ```
  tab "Belongings" · Mitsuki · CookieTin: nested blocks below depth 3 are not rendered
  ```
- The group cap applies PER LEVEL. Three levels of 64 is already far past a glance surface, which is
  what the depth cap is for.
- A `fields` block nests too — a nested block is just a block.

### Anything else

A block whose `type` this build does not know is **skipped silently** — a later format may add types,
and an old host must not warn about every one of them on every render.

---

## 4. Paths

A path is dotted, and its FORM names the root it reads from.

| Form | Reads from | Use it for |
| --- | --- | --- |
| `RelayTurn` | your own state scope | everything the artifact wrote itself |
| `{cast@1}.Mitsuki.Hobbies` | the game path your `requires` / `optionalUses` interface resolved to | reading the pack you decorate, **portably** — you never spell its vocabulary |
| `$.World.Time` | the `stat_data` root, raw | you know THIS card's shape and say so |

Your own scope depends on what you are:

| Artifact | Scope a bare path reads from |
| --- | --- |
| GameLogic Pack | the `stat_data` root |
| GameLogic Plugin | your own drawer, `GameLogicPlugin.<stateName>` |

The two escapes mean the same thing **wherever** they appear — inside a `collection`'s per-child
`fields` included, where a bare path is relative to the child and `$.` / `{token}` still are not.

`$` alone is the `stat_data` root. `{token}` alone is the whole interface target.

**Values**

- An MVU `#tuple` — `[value, "Label"]` — renders its VALUE. Only that exact two-slot shape unwraps;
  a plain list is data.
- An object renders as `{N keys}`, a list joins with `, `. Use a `collection` to show structure.
- A value over 400 characters is cut with `…`.

**When a path finds nothing**

The row renders a dim `·` and the host logs ONE warning per path per chat. The slot is never refused.
Two different misses, two different sentences, because they are two different author mistakes:

```
path "Nope" resolved to nothing
token "{cast@9}" is not exposed by the active pack — nothing to read
```

---

## 5. `style` — colour, per cell

A row is a table row: a **label** cell, a **value** cell, and the **row** itself. Paint is declared per
CELL, under `style`. Colour is presentation, so it belongs in the declaration beside the path it
paints.

```jsonc
{ "label": "Energy", "path": "Energy", "style": {
    "label": { "color": "#888888" },                          // static
    "value": { "color": [ { "lt": 20, "use": "#dd6a6a" },     // rules, FIRST match wins
                          { "lt": 50, "use": "#d3a03c" },
                          { "use": "#5cb37a" } ],             // no condition = the default arm
               "background": "#2a1414" },
    "row":   { "background": [ { "lt": 20, "use": "#180000" } ] } } }
```

ONE grammar at every level:

```
style  ->  { <cell>: paint }
paint  ->  { "color": colour, "background": colour }
colour ->  "#rrggbb"  |  [ rule, rule, … ]
rule   ->  { <conditions…>, "use": "#rrggbb" }
```

### Which cells a site may paint

| Declared on | Cells | Its rules judge |
| --- | --- | --- |
| a `field` | `label` `value` `row` | that row's value |
| a `fields` block | `heading` | the heading TEXT |
| a `collection` block | `heading` `groupKey` | `heading` the heading text, `groupKey` the group's KEY |

A group heading has no field of its own, which is why the BLOCK declares it:

```jsonc
{ "type": "collection", "path": "{cast@1}",
  "style": { "groupKey": { "color": [ { "eq": "Mitsuki", "use": "#e08ac0" }, { "use": "#888888" } ] } },
  "fields": [ { "label": "Outfit", "path": "Outfit" } ] }
```

A cell name outside the site's list is reported with the list named — never silently ignored:

```
tab "Lane" — "Energy": unknown cell "groupKey" (this one paints: label, value, row)
```

All three row cells judge the **same value**. That is what lets a low stat colour its own label.

### Colours are hex, and only hex

`#rgb`, `#rrggbb`, and their alpha forms `#rgba` and `#rrggbbaa` — the last digit or pair is opacity,
`00` fully transparent through `ff` fully opaque. Not `red`, not `rgb(1,2,3)`, not
`var(--SmartThemeQuoteColor)`.
The string is handed to a style property, so nothing but a colour literal is allowed through, and a
rejected value is REPORTED rather than quietly dropped:

```
tab "Lane" — "Energy": "tomato" is not a hex colour (#rgb, #rgba, #rrggbb or #rrggbbaa)
```

mvu-helper defines no palette of its own — the colours are yours. The cost you own with them: a hex
ignores the user's SillyTavern theme, so a colour picked against a dark ground can read badly on a
light one. The panel cannot see that and will not pretend to.

### Gradients, and transparency

`background` also takes a **gradient**, written as an OBJECT. That shape is not decoration: a string
is already a hex and an ARRAY is already the rule list, so a list of stops could never be one without
becoming ambiguous.

```jsonc
"background": { "stops": ["#2a1a4a", "#1a2f4a"], "angle": 100 }
"background": { "stops": ["#4a2a1a", "#4a3a1a", "#2a1a10"] }        // angle defaults to 90
"color":      [ { "gt": 5, "use": { "stops": ["#111", "#222"] } } ]  // REFUSED — text takes no gradient
```

- 2 to 6 stops, every one hex-checked; `angle` is degrees and anything non-numeric falls back to 90.
  The CSS is BUILT from those validated pieces, never copied from what you wrote.
- A gradient is a BACKGROUND. Declaring one for `color` is refused and said so.
- It works anywhere a colour does, `use` inside a rule included.

**Transparency** needs nothing new. A cell with no `background` has none — that is the default — and
the 4- and 8-digit hex forms carry alpha, so `"#7ea6e022"` is a faint wash of that blue over whatever
is behind it:

```jsonc
{ "label": "Time", "path": "$.World.Time", "style": { "value": { "background": "#7ea6e022" } } }
```

### Conditions

| Condition | Matches when | Notes |
| --- | --- | --- |
| `lt` | value `<` it | numeric |
| `lte` | value `<=` it | numeric |
| `gt` | value `>` it | numeric |
| `gte` | value `>=` it | numeric |
| `eq` | the value's text equals it exactly | case-SENSITIVE, compared as strings |
| `has` | the value's text contains it | case-INSENSITIVE substring |
| `is` | the value's truthiness equals it | `true` / `false` |
| *(none)* | always | the DEFAULT arm — put it last |

How a rule list is read:

1. Rules are scanned **in declaration order**; the **first** match wins and the rest are not consulted.
2. Every condition present in ONE rule must hold — they AND:
   ```jsonc
   { "gte": 10, "lt": 20, "use": "#d3a03c" }   // the 10–19 band, one rule
   ```
3. A rule with no condition at all always matches, so it is the fallback. Anywhere but last, it makes
   every rule after it dead.
4. A numeric test needs a **real** number. `""`, `null`, `false` and `[]` do NOT count as zero — an
   empty stat never paints itself red. A numeric string (`"12"`) does count.
5. The value tested is the value AFTER `#tuple` unwrap: `[12, "Energy"]` tests as `12`.
6. A row whose path resolved to nothing is **never painted**, static colours included. Every rule is a
   judgement about a value, and there is none here to judge.

```jsonc
// worked: three bands and a fallback, plus a warning ground on the row
"style": {
  "value": { "color": [ { "lt": 20,           "use": "#dd6a6a" },
                        { "gte": 20, "lt": 50, "use": "#d3a03c" },
                        { "use": "#5cb37a" } ] },
  "row":   { "background": [ { "lt": 20, "use": "#180000" } ] }   // no fallback = unpainted above 20
}

// worked: a boolean flag lighting its own row
"style": {
  "value": { "color":      [ { "is": true, "use": "#ffd24a" }, { "use": "#888888" } ] },
  "row":   { "background": [ { "is": true, "use": "#3a2c05" } ] }
}

// worked: a string state
"style": { "value": { "color": [ { "eq": "Lover",  "use": "#e08ac0" },
                                 { "has": "friend", "use": "#5cb37a" },
                                 { "use": "#888888" } ] } }
```

---

## 6. Caps

Everything over a cap is dropped rather than scrolled forever — a panel is a glance surface.

| Cap | Limit |
| --- | --- |
| tabs per slot | 8 |
| blocks per tab | 8 |
| rows per block | 64 |
| groups per collection | 64, PER level |
| characters per value | 400 |
| rules per colour | 8 |
| gradient stops | 6 |
| collection nesting depth | 3 |

---

## 7. Computing a slot instead of binding it — `renderPanel`

An artifact's hosted engine may export `renderPanel(ctx)` and COMPUTE its whole view. When it does, it
replaces the bound declaration for that slot — so it must emit every tab, not just an extra one.

```js
renderPanel({ ownState, snapshot, engine, exposes }) { … }
```

The ctx is the relay's read side without the turn fields (`ops`, `mid`, `swipe`): a render is not a
turn and must not look like one. It returns DATA in the same block vocabulary, with VALUES already
computed — it had the state in hand, so paths would only make the host walk the tree twice:

```js
{ title,
  tabs: [ { id, name, blocks: [
      { type: 'fields',     heading, style, rows:   [ { label, value, style } ] },
      { type: 'collection', heading, style, groups: [ { key, style, rows: [ { label, value, style } ], blocks } ] },
  ] } ] }
```

A group's `blocks` nests exactly as a declaration's does, capped at the same depth — the hook is not a
way around the caps. `heading` and `style` take the same cells and hex/gradient checks as a declaration, so
the hook cannot smuggle CSS in through this door, with one difference: a computed collection paints
`groupKey` on each GROUP (`groups[].style.groupKey`), because the hook builds every group itself, where a
declaration paints it on the block and has it judged per key. A paint the checks refuse, or nesting past
the depth cap, is reported the same way as for a declaration (§8), the line starting with `renderPanel`:

```
"probe" renderPanel tab "Lane" — "Energy": "tomato" is not a hex colour (#rgb, #rgba, #rrggbb or #rrggbbaa)
```

Markup is never accepted; every value renders as text. Output that does not fit the shape renders the bound
declaration instead, and so does a throw.

**Which lane?** Bind it in the declaration when it is a plain read: no code, and nothing to go stale.
Compute it in the engine when the value must be joined, counted, compared, or found by ENUMERATING
keys nobody can name in advance — a declaration names a fixed path and cannot enumerate.

---

## 8. What warns, and what refuses

| Situation | What happens |
| --- | --- |
| the panel entry is not JSON, or is not an object | the SLOT is skipped, with the parse error — the author must hear it |
| `kind` is not `slot-list` | the slot is skipped, kind named, at verbose level — nothing is broken |
| a path resolves to nothing | the row renders `·`, ONE warning per path per chat |
| a token the pack does not expose | same, with the TOKEN named |
| a collection path is missing, or lands on an array or scalar | the block renders `—`, one warning |
| an unknown block `type` | skipped silently — a later format may add it |
| nested blocks past the depth cap | dropped, warned ONCE for that block; every level above renders |
| an unknown cell name | reported with the site's cell list |
| a colour that is not hex | reported with the field and the offending string |
| a gradient with bad stops, too few/many, or declared for text | reported, and the cell paints nothing |
| `renderPanel` returns junk, or throws | warned, and the slot renders from its declaration instead |

Every warning in this table is logged once per chat, however often the panel re-renders, and a computed
panel's are reported the same way as a declaration's (§7). Nothing in this table refuses a slot except a
declaration that would not parse.

---

## 9. The live worked example

`Schoolv4/workspace/plugin-standalone-probe/panel/panel.json` in the MvuGameMaker repo exercises every
feature above: both block types, all three path forms, per-cell paint on `label` / `value` / `row`, a
`groupKey` paint on a collection block, and static colours beside rule lists. Its `Belongings` tab is
the nesting example — every classmate through `{cast@1}`, and each one's `Belongings` map below it,
each level painting its own heading. Its `Foreign` tab shows
the declaration lane and the engine lane side by side on the SAME two values — `$.World.Time` and a
`{cast@1}` collection bound here, beside `ExampleWorldTime` and `ExampleHobbies` computed from
`snapshot` + `exposes` in its `engine/relay-resolver.cjs`, which carries the commented walkthrough.
