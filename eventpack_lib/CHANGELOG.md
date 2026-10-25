# eventpack.cjs changelog

`eventpack.cjs` is the one library that runs every event pack. Your game loads it in its engine and declares an adapter, once. After that, every pack is just data. How to wire it is on [Host event packs in your game](../doc/eventpack_engine/host.md).

Never edit your copy. To update, replace the whole file with the one in this folder. Then read every entry below, down to the version you had.

## 3 version numbers

The file carries 3 numbers, and each one tells you something different.

| Number | Now | Where you see it | What it covers |
| --- | --- | --- | --- |
| Library version | 1.0.4 | the file's first comment line | this file's own release |
| WHEN-DSL grammar | 1.7.0 | the same line, `(WHEN-DSL grammar v1.7.0)` | the condition language a pack's `prereq`, `when` and `whenAny` are written in |
| Pack format | 1.2 | `FORMAT` inside the file. Your engine re-exports it as `EVENT_PACK_FORMAT` | what a pack may hold and still run |

The grammar lives in 3 places: this file, MVU Helper and MVU Status Menu Builder. All 3 carry the same grammar version. So when the language changes, all 3 change together. See [The same grammar in 3 places](../doc/eventpack_engine/dsl.md#the-same-grammar-in-3-places).

## What a new version asks of you

The library version tells you how much work an update is.

- **Major** (like 2.0.0): something that already worked now behaves differently, or an adapter hook became required. Re-read [Host event packs in your game](../doc/eventpack_engine/host.md) and check your adapter.
- **Minor** (like 1.1.0): the grammar or the pack format moved. Re-check your packs, and update MVU Helper and MVU Status Menu Builder too.
- **Patch** (like 1.0.5): nothing to do. It's a fix, or a new OPTIONAL feature.

It's like a game console update. A patch you install and forget. A minor one means some new cartridges need it. A major one means read the notes before you play.

## 1.0.4 (2026-10-25)

WHEN-DSL grammar 1.7.0 · pack format 1.2

The first public release. Before this, the file only came straight from me.

**What it does.** It checks each event's conditions every reply, and arms the next event. When the narrator plays it, it checks the conditions again, applies the pack's writes under the rules your game declares, pays its rewards and marks it done.

**What grammar 1.7.0 understands.** Every token on [The condition language](../doc/eventpack_engine/dsl.md):

- compare, like `Aff(Mitsuki)>=40`, with `>=` `<=` `>` `<` `=` `==`
- in set, like `Wkd in {Saturday,Sunday}`
- `Present(Mitsuki)`
- `flag:paulk_beach_arc_invite`
- `contains(Classmate.*.Mood, "Excited")` and `has(Mainchar.Inventory, "camera")`
- `!` to flip one token
- `*` in a path, for any entry
- `DaysSince(path)`
- `whenAny`, a list of strings where any one is enough
- a raw stat_data path on the left, like `Mainchar.Money`, plus your game's own shortcuts, like `Aff(Mitsuki)`

**What pack format 1.2 holds.** 1.0 is every token above plus `fx.writes`. 1.1 adds `fx.reward`. 1.2 lets a keyed reward name its member by a selector, `<path>.*.<field>`.

**The adapter.** Required: `triggerRoot`, `get`, `getArmed`, `setArmed`, `warn`. Optional, each one warns by name when it's missing: `daysSince`, `nowStamp`, `resolveScalar`, `getStepDone` / `setStepDone`.

## Adding an entry

Every time `eventpack.cjs` changes here, add an entry on top, newest first. Give it the library version, the date, the grammar version and the pack format.

When the grammar version moves, list every new token or form, with an example. When the pack format moves, list the new fields. A new adapter hook says whether it's required or optional.

Basically, a dev reading this file should know what an update gives them, and what it asks of them, without opening the code.
