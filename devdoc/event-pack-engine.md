# Event-pack engine — genre adoption contract

Audience: the author of a GENRE backport (RPG, Love, …) adopting the event-pack engine. This is the
DO / DON'T contract — you should never need to read `eventpack.cjs` to stay compatible. Pack-AUTHOR
docs live in `devdoc/event-pack-format.md`; the design that produced this contract is
`MvuStatMenuBuilder/plans/executed/eventpack_revisit.md`.

Engine format level: **1.2** — the library's own `FORMAT`, in `GameLogic/_engine/eventpack.cjs`; its
banner beside it carries the file version and the WHEN-DSL grammar version. Read them there rather
than from a number copied to here. A grammar, rule or format change updates this doc and mvu-helper's
validator in the same change.

## The promise

A pack exported by MvuStatMenuBuilder runs on ANY card whose engine loads `eventpack.cjs` and declares
an adapter. **Nothing per pack is ever written into a genre engine.** The genre writes its adapter
ONCE — declarations of where its state lives, where a pack may write and under which rules, what its
clock is, how its sugar spells paths — and every pack thereafter is data.

## The pieces and where they live

| Piece | Home | Per-genre cost |
|---|---|---|
| Pack format + validator + scanner + install tab | mvu-helper (one extension, all cards) | zero |
| `eventpack.cjs` — WHEN-DSL grammar, LHS resolution, scan tie-break, verify-at-fire, `applyWrites` (§Write rules), `applyRewards` (the reward ceilings), the done-marker | `GameLogic/_engine/eventpack.cjs` (game repo, shared; each genre ships a byte-identical copy in its `engine/` folder) | zero (consume it) |
| The grammar's two vendored twins — parse + emit only, no evaluation | `mvu-helper/src/features/event-pack/when-dsl-grammar.js` (install-side lint) · `MvuStatMenuBuilder/landing-app/src/utils/when-dsl-grammar.js` (builder GUI); byte-identical to each other | zero |
| The `adapter` — paths, writable paths + rules, reward kinds, clock, aliases, presence | your genre's `globalLogic.cjs` | one object of declarations |
| Event bodies (prose) | your card's `<Event_Schedule>` + community `[MVU_Event_Pack]` entries | authored content |

Reference implementation: `Schoolv4/workspace/gamelogic/engine/globalLogic.cjs` (`EVENT_PACK_ADAPTER` +
thin wrappers), assembled by `Schoolv4/Tools/build_workspace.cjs`.

Starting from nothing: a blank GameLogic pack from mvu-helper's **Add New Blank Packs** carries
`engine/README.txt` — where to get `eventpack.cjs`, the `engineOrder` that loads it first, the schema
roots, and a minimal `gameLogic.cjs` with the adapter and `resolveTurn` wired. mvu-helper's suite runs
that code against the real library, so it stays a working starting point.

### Who reads the adapter, and how — two channels, one source

**Both tools read the EXPORTED adapter.** Export `EVENT_PACK_ADAPTER` (and `EVENT_PACK_FORMAT`) from
your engine and that is the whole obligation — one place a declaration lives, so there is no second
place it can be wrong.

- **mvu-helper** asks the engine it already has loaded: the install gate, the scan pass and the
  before-generation seed all read the live object. No rebuild is needed for it to see a change —
  reload the engine and it reads what is there.
- **MvuStatMenuBuilder's event builder** ingests a built card FILE offline, with no engine running
  and no chat, so it RUNS the card's engine bundle and reads the same exports off it. The engine
  entry is found by its `[mvu_logicengine]` comment marker; the marker locates the entry, and what
  the entry declares decides the rest.

Nothing you write has to be a string literal for either tool's sake. A value that exists only as
generated text describing your adapter is a COPY, and a copy drifts — which is the one failure this
contract exists to prevent.

## A genre SHOULD

- **Store ALL event definitions under one root** (`.triggers` = every row, official base + community
  overlay; `.installed` = the community-pack registry beside it). Seed your official events there from
  your `[InitVar]`. mvu-helper re-applies it to running saves create-only, so a row you ADD reaches them by
  itself. A row you CHANGE reaches them only when your GameLogic Pack lists the table under
  `state.forceFromInitVar` and you bump `state.version` (`gamelogic-pack-format.md` §8). That push replaces only
  the rows your `[InitVar]` carries, and deletes none, so community rows stay.
- **Consume `eventpack.cjs` and supply ONLY the adapter.** Every entry is a DECLARATION, evaluated at
  call time:
  - `triggerRoot` / `armedPath` — dotted paths. Those are the only two. Both tools read them off the
    exported adapter, so any expression that evaluates to the right string works. The library keeps its
    OWN stores beside your trigger table — `<root>.installed` (the installer's watermark) and
    `<root>.fired` (the done-marker) — so a fired event is never recorded inside a genre store, where a
    player editing their save could un-fire it.
  - `writes` — an array of `{ path, …rules }`: where a pack may write, and under which of the library's
    rules (§Write rules). Declare what your genre needs; implement nothing.
  - `rewards` — OPTIONAL: what a row may PAY when it fires (`fx.reward`, format 1.1). An array of kinds
    `{ name, path, keyed?, fields, clamp?, max }`. `fields` is the allow-list; `clamp` bounds the RESULT
    (`{ field: [lo, hi] }`, each bound a number, a sibling field's name, or `null` for no bound that
    way); `max` is the largest SINGLE payout — one number, or `{ field: n }` when the fields do not share
    a scale — applied to the magnitude, and an over-max amount is paid at the ceiling and logged.
    `keyed: true` makes `path` a collection whose member the row names, or picks by a selector
    `<path>.*.<field>` (format 1.2): whoever that boolean field marks, exactly one. A text kind
    (`text: true` with `maxLength` in place of `clamp`/`max`) pays prose written over the field, cut to
    `maxLength`. A keyed kind is not owner-gated: it reaches only the listed fields, by a capped amount,
    on a member that already exists. Declare none and a row asking for a reward is refused by name.
  - `nowStamp(sd)` — the clock: the string every `stamp` field receives.
  - `daysSince(sd, stamp)` — whole days from a stamp to "today", or `null` for a non-stamp. Only you know
    which day is being PLAYED (School's game-day differs from the civil date during its small hours). A
    plain civil clock writes one line: `daysSince: (sd, s) => EVENTPACK_API.civilDaysSince(nowStamp(sd), s)`.
    Without it every `DaysSince()` reads never, warned once — never a silent civil default.
  - `aliases` — your WHEN-DSL sugar as DATA: `{ 'Aff(*)': 'Classmate.*.Affection', Loc: 'World.Location' }`.
    A `*` captures a paren argument or a segment and lands in the path. The builder offers your KEYS
    beside the library's own forms (`DaysSince(*)`), joined from the running bundle.
  - `presence` — the path `Present(Name)` tests, `=== true` after unwrap: `'Classmate.*.Is_present'`.
  - `resolveScalar(sd, lhs)` + `sugar` — OPTIONAL, for a form that genuinely COMPUTES (a party size, a
    count). Return `lhs` unchanged for anything you don't claim. School declares none.
  - `scopes` — the scope values a row may declare. The library stores a row's scope verbatim on its
    done-marker and never reads it; YOUR reset decides what it means (School: `timeLeap` clears every
    marker that is not `save`). Declare none and the builder's Scope field stays free text.
  - `bodyEntry` — OPTIONAL: where an installed pack's worldbook entry goes in YOUR prompt, as
    `{ position, depth, order }` in TavernHelper's entry vocabulary (School: `{ position:
    'at_depth_as_system', depth: 0, order: 750 }`, after the player's line and below its own beats).
    mvu-helper writes it onto every pack entry it installs and interprets none of it; a malformed one
    refuses the install, naming the field. Declare none and the entry keeps the host's default slot.
  - `get(value, default)` — unwrap YOUR storage shape (School: `[value,"Label"]` tuples).
  - `getArmed(sd)` / `setArmed(sd, v)` — the armed-event pointer (`'@key'` or `''`); derive them from
    `armedPath`, keep them observationally exact (always a String, the label preserved).
  - **The armed pointer has ONE storage shape: an MVU `[value, label]` pair** — `['@key', 'label']`
    while an event is armed, `['', 'label']` when none is. MvuStatMenuBuilder builds the variable this
    way and writes every pack body behind `getvar('stat_data.<armedPath>[0]') === '@key'`. On a plain
    string, `[0]` reads only `'@'`, so every event would arm and no body would ever show. mvu-helper
    therefore refuses an install onto any other shape, and logs an error on every chat load while packs
    are installed on one. Seed the pair in your initial state (School's `initmvu.json`:
    `"EventArmed": ["", "Current Event"]`).
  - No recorder hook. A fire writes `<trigger root>.fired.<key> = { state: "done", scope, at }` in the
    library's own root — that is the one-shot gate, what `flag:<key>` reads, and what mvu-helper counts.
    PROSE is not the engine's: if a beat belongs in your world log, have the body tell the narrator to
    report it (School: `emit /Intent/recordEvent "save|…"`), so the log holds only what mattered.
  - `warn(message)` — your warn channel. The library never prints on its own.
- **Bake the library as a PRELUDE** before your globalLogic (dual-mode: Node `require` for tests,
  browser `__EVENTPACK__` global) and VERIFY the bake — School's verifier fails on a stale copy.
- **EXPORT what you declare.** `module.exports` must carry `EVENT_PACK_ADAPTER` and
  `EVENT_PACK_FORMAT` — the level you claim to execute, normally the library's own `FORMAT` passed
  straight through (`EVENT_PACK_FORMAT: (EVENTPACK_API && EVENTPACK_API.FORMAT) || null`, as School
  does). That export is the only way either tool sees your declarations: an adapter built but never
  exported reads as a card that cannot host packs at all. A missing declaration is a refusal naming
  the field, never a default.
- **Keep the self-gating body pattern**: flat armed-event gates on your own `armedPath`
  (`<%_ if (getvar('stat_data.<armedPath>[0]') === '@key') { _%>`) + the `if (false)` JSON hide.
  mvu-helper's install lint enforces exactly those EJS shapes.
- **Fire what the narrator reports.** Every pack body's FIRE line asks the narrator to emit
  `/Intent/eventFire "<key>"` (or `"<key>:<Outcome>"`). In `resolveTurn`, hand that value to the library's
  `applyEventFire(statData, value, log, adapter)`, then clear it so it never applies twice. The channel
  name `eventFire` belongs to the FORMAT, not to you: mvu-helper refuses a pack whose body lacks the
  emit, and its same-reply header asks the narrator for the same channel. Without this route an event
  plays and never fires, so nothing it declares is applied and it plays again. The blank GameLogic
  pack's `engine/README.txt` shows the wiring.
- **Pick the same-round event, if you want one (optional).** Without this, an event arms when it ripens
  and plays the reply after. To let it play in the reply it ripens in, export
  `pickSameRoundEvent(statData, ctx)`. mvu-helper calls it after the card's PRE calls, with the state
  those calls read and `ctx.preOutputs` = each call's raw output and the ops it applied, `[{ name, output, appliedOps }]` (beside
  `type`, `mid`, `swipe`, `generationAttempt`). Return the key to play this reply, or `''`.
  - **What is yours:** everything that decides the key. That means what the PRE calls were shown (School
    renders a candidate list from the library's `sweepCandidateLines` and `readyEvent` in a `[PRE]`
    entry), which field of their output carries the verdict (School's is `"eventReady"`), and whether
    the key named is one you actually offered, judged on the `statData` you are handed. mvu-helper
    calls no engine-specific function and reads no card-specific field.
  - **What is mvu-helper's:** playing the key you return. It finds the `@key`-gated body in the card's
    lorebook (the format's own gate), injects it for the narrator with the `/Intent/eventFire`
    instruction, and hands the key back to `resolveTurn`. A non-string return plays nothing and is
    warned with what it was.
  - **Your engine still verifies at fire,** so a pick is only ever a proposal.
  - **Reference:** MvuGameMaker's `GameLogic/Schoolv4/doc/GameLogicEngine_Guide.md`.
- **Judge your own same-round misses.** When mvu-helper's PRE seam plays the event you picked in THIS
  reply, it hands `resolveTurn` that event's key in `ctx.sameRoundEventKey` (`''` when none). If your engine
  then ARMS that key instead of firing it, the narrator played the beat without reporting the fire, and
  the scene replays next reply. Saying so is your engine's job: mvu-helper offers the fact, never the
  verdict.

## A genre SHOULD NOT

- **Write an applier.** There is no `fx.<type>` and no applier map. A pack names a PATH you declared and
  the schema's own FIELDS; the library writes them under your rules. If you find yourself mapping a
  pack word to a field name, the pack should have used the field name.
- **Re-implement the WHEN-DSL grammar, the LHS resolution, or the scan tie-break** (TIME>TRG ·
  most-specific-WHEN · declaration order). That drift is what the library exists to kill. Need a new
  operator? Extend the LIBRARY in a shared change (grammar has ONE source, vendored into two repos),
  bump the format level, update this doc + mvu-helper's validator together.
- **Let a pack reach a record it does not own.** Give every collection a pack may write an
  `ownerStamp` (§Write rules). A path declaring none refuses every keyed pack write — it fails CLOSED,
  so you cannot hand out an unguarded collection by forgetting a line. Do not weaken that with a
  genre-side exemption.
- **Let packs write live game state by any route but `writes`.** Packs carry DEFINITIONS; the only
  state a pack changes is what its writes declare, under your rules. Pack install/upgrade/uninstall
  must never touch live state, with ONE exception, which mvu-helper makes and you do not: when an
  uninstall, a disable or an upgrade removes the event your armed pointer names, mvu-helper sets the
  pointer's value to `''` (the label stays), so the next reply is not told to play a body that is gone.
- **Break stable trigger keys.** Keys are identity across versions — renaming keys orphans fired
  one-shot state and forks quest series.

## Write rules (`adapter.writes`)

Each `writes` entry names a `path` and any of these rules. The library applies them in one pass per
write; the genre implements none of them.

| Rule | Does |
|---|---|
| `ownerStamp: 'Field'` | the field a record names its maker in — THE OWNER GATE (below). A path without it refuses every keyed pack write |
| `fixed: { Field: value }` | written by the engine on every write; a pack cannot set it |
| `stamp: 'Field'` | receives `nowStamp(sd)` on every write — what `DaysSince()` reads. On a `fillOnly` path it is a capture time, kept once set |
| `locked: ['Field']` | a pack may neither set nor add it; the field is dropped with a log line and the rest of the write lands |
| `monotonic: ['Field']` | a value at or below the current one skips the WHOLE write; a negative `add` is dropped |
| `fillOnly: true \| ['Field']` | an existing non-empty field is never overwritten; `true` also makes the path a SHARED REGISTRY (below) |
| `add: ['Field']` | the field accepts a numeric delta (`add`) on top of `set` |
| `clamp: { Field: [min, max] }` | bounded after the write; a bound is a number or a sibling field's name |
| `removable: true` | a write may carry `remove: true` |
| `removeAtZero: ['Field']` | the record is deleted when the field is at or below 0 |
| `capacity: { max, evictBy }` | a new key past `max` first evicts the oldest record by `evictBy` |

Two constants hold on every path: a field whose name starts with `_` is never written by a pack (MVU's
readonly convention), and a `key` may not contain `.` or `/` (MVU's path delimiters).

**The owner gate.** A pack may CREATE any record key nobody has claimed, and the library writes the
pack's id into the path's `ownerStamp` field; afterwards the pack may overwrite or remove only a record
its own id stamped. A record with no stamp was made by the narrator or the player and belongs to no
pack. The card's OWN rows (its seeded official events) are never gated — that is how an official row
takes back an item the narrator created and never stamped.

**A shared registry** (`fillOnly: true`) is the one exception: a pack names the record key your world
already uses (`School_Cafeteria`, not a duplicate of it) and can only fill its blank fields, so it never
overwrites what the engine or another pack recorded. Removal is never shared — deleting a record is not
filling a blank.

## Format bump rules (who bumps what)

- New **predicate/DSL operator** (an old engine can't evaluate it → event never fires) ⇒ **MAJOR**.
- New **write rule / optional field** (an old engine ignores it → fires minus the extra) ⇒ **MINOR**.
- A grammar change lands in ALL of these in ONE pass, and every grammar file carries the same grammar
  version:
  1. `GameLogic/_engine/eventpack.cjs` — `FORMAT`, the grammar, the version header; then rebuild every
     genre workspace (`Tools/build_workspace.cjs`) so the copies refresh.
  2. `mvu-helper/src/features/event-pack/when-dsl-grammar.js` — the vendored parse+emit twin;
     `SUPPORTED_FORMAT` and `FEATURE_FORMAT` in `event-pack-core.js`; the corpus in
     `tests/when-dsl-grammar.test.js`.
  3. `MvuStatMenuBuilder/landing-app/src/utils/when-dsl-grammar.js` — byte-identical to 2; the
     builder's condition-kind list in `EventPackTab.vue`.
  4. This doc + `devdoc/event-pack-format.md`.
- Drift guards: `tests/when-dsl-grammar.test.js` executes the REAL `eventpack.cjs` against the vendored
  copy over a token corpus and byte-compares the two twins. Each guard skips ONLY when that sibling repo
  is not checked out at all; a checkout whose file is not where this list says FAILS by name. The
  builder's `tools/check-grammar-drift.mjs` proves the twin pair from its side.
