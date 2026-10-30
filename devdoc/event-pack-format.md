# Event Pack format — author guide

Audience: anyone writing a community **event pack**. An event pack adds a whole event series —
triggers, story beats, writes into the state the card opens, and payouts — to a supported card as
**one block of text** the player pastes into MVU Helper's **Event Packs** tab.

Write it by hand from this page, or let MvuStatMenuBuilder's **Event Pack** tab generate it from an
uploaded card (its guide, MvuStatMenuBuilder's `devdoc/event_pack_wording.md`, explains the fields, and the
tab links to it). Either way the result is the text below, and the installer checks it the same way. What one particular card lets a pack write and
pay is that card's own page — School v4: MvuGameMaker's `GameLogic/Schoolv4/doc/event-pack-adapter.md`.

---

## 1. What a pack is

ONE pack = ONE event **series** (an arc of up to 20 steps/beats) = ONE text. It has two halves in
the same text:

1. **A hidden JSON block** — the trigger rows (WHEN an event arms, and what it WRITES and PAYS when
   it fires).
2. **Self-gated prose bodies** — the DO/FIRE text the narrator plays when a trigger arms.

The player installs it in the **Event Packs tab** (paste → Validate → Add & install). Hand-pasting the
text into the worldbook does nothing — only tab-installed packs are scanned (that is a security
fence, not a bug).

## 2. The template

```
<%_ if (false) { _%>
<mvueventpack>
{
  "format": "1.0",
  "creator": "YourName",
  "event": "YourArc",
  "version": "1.0",
  "triggers": {
    "yourname_yourarc_1": {
      "cat": "TRG",
      "series": "YourArc",
      "when": "Wkd=Saturday & T>=10:00",
      "fx": {
        "summary": "Opens the Your Arc quest.",
        "scope": "arc",
        "writes": [
          { "path": "Mainchar.Quests", "key": "yourname_yourarc_quest",
            "set": { "Step": 1, "Title": "Your Arc", "Status": "On-going", "Desc": "…", "Objective": "…" } }
        ]
      }
    }
  }
}
</mvueventpack>
<%_ } _%>
<%_ if (getvar('stat_data.EngineDerived.EventArmed[0]') === '@yourname_yourarc_1') { _%>
<Event_Pack>
@yourname_yourarc_1  Your Arc ·1   (CHECK - )
  DO  …prose the narrator plays THIS reply…
  FIRE  emit /Intent/eventFire "yourname_yourarc_1" → …what the engine records…
</Event_Pack>
<%_ } _%>
```

Repeat the gated body block once per trigger key. The `if (false)` wrapper makes the JSON render
zero prompt tokens; each body renders only on the reply its key is armed. The `<Event_Pack>` tags are
plain text inside the gate: the builder writes them, and a card's prompt may point the narrator at
them (School v4's does). The installer opens your pack's worldbook entry with an `@@if` on the pack's
own keys, so the entry is dropped on every reply none of them is armed — text you write outside a gate
shows only while one of your beats is armed — and puts the entry where the card's engine declares
(`bodyEntry`, `event-pack-engine.md`).

> ⚠ **`EngineDerived.EventArmed` is THIS card's armed path (School v4's), not a constant.** The path is
> declared by the card's own logic engine, so a different card uses a different one, and a gate written
> against the wrong path never fires and never errors.
>
> You do not have to guess it. The installer lints every `<%` block against the armed path the loaded card
> actually declares, and a mismatch is **rejected at install with the correct spelling in the message**.
> Paste the pack, read the rejection, use the path it names.
>
> **The `[0]` is not optional.** The armed pointer is an MVU `[value, label]` pair on every card that
> can host packs, and `[0]` reads its value. A gate without `[0]` compares the whole pair to a string,
> never opens, and is refused at install.

**EJS is locked down.** The ONLY `<%` sequences allowed are the three shown above (the `if (false)`
wrapper, the flat armed-event gate, the `<%_ } _%>` closer). Anything else is rejected at install.

## 3. Identity & keys (strict — the validator enforces these)

| Field | Rule |
|---|---|
| `creator` | required; must survive slugging (lowercase, spaces→`_`, only `[a-z0-9_]` kept — a name with no latin letter or digit slugs to nothing and is refused); may not contain `official`, the word for the card's own events |
| `event` | required; same slug rule; ONE series per pack — a second arc is a second pack |
| `version` | required; `M.m` or `M.m.r` (e.g. `"1.0"`, `"1.2.1"`) |
| `format` | **required**; `M.m` — the pack-format level this pack NEEDS (§6) |
| `builtWith` | optional; the tool that produced this file (e.g. `"MvuStatMenuBuilder 1.2.0"`). The visual builder stamps it; hand-authored packs leave it out |
| pack ID | derived: `slug(creator).slug(event)` — e.g. `paulk.riverarc` |
| trigger keys | must start with `slug(creator)_slug(event)_` and use only `[a-z0-9_]` |

**`format` is checked against what you actually WROTE.** Every construct in this guide — `!` negation,
`contains()`, `has()`, `*` wildcard paths, `whenAny`, `DaysSince()`, `fx.writes` — is a 1.0 construct, so
`"1.0"` is the number to write today unless a row pays an `fx.reward` (`"1.1"`, or `"1.2"` when a reward
names its member by a selector). The builder derives the number the same way. When a later format adds
a construct, a pack declaring an older number while using it is REFUSED with a message naming the
operator and the number to use, because the mistake is otherwise invisible: the pack would install on
the older card, the engine could not parse the token, and the event would simply never fire. Declaring
a level HIGHER than you use only narrows which cards accept the pack.

**`builtWith` never affects whether a pack installs.** It is a receipt, so that if a bug is later found
in the tooling, the affected packs can be identified. Nothing gates on it.

**Never rename keys between versions.** The pack ID + `version` drive upgrades; keys are stable so
fired one-shots and quest progress survive an upgrade. Bump `version` on every content change —
same/older versions are rejected at install (no downgrade path; uninstall first to roll back).

Caps: ≤ 20 trigger rows per pack · ≤ 4 KB JSON per row · ≤ 64 KB total text.

## 4. Trigger rows

| Field | Meaning |
|---|---|
| `cat` | `TRG` (condition-armed) or `TIME` (a clock- or date-anchored beat). When two rows are ripe at once only one arms: TIME before TRG, then the row with more conditions (`prereq` + the `when` that holds), then the one declared first |
| `series` | the arc name — identical on every row of the pack |
| `prereq` | is this event ON THE TABLE at all — durable story state; AND only (`''`, `-` or absent = none) |
| `when` | is THIS the moment — time, place, who is present |
| `whenAny` | instead of `when`: an array of alternatives, ANY one of which arms the row (each still an AND-chain). A row carrying both is refused |
| `fx` | what the event records, WRITES and PAYS when it FIRES (see below) |

### PREREQ vs WHEN

Both must hold before a row arms. Keep durable story state in PREREQ and the moment in WHEN, because
the engine reads the split: for every row whose PREREQ holds and whose WHEN is exactly ONE condition
short, it names that condition and its current value —

```
paulk_riverarc_2 · need Loc=Outskirts_River
example_3 · need Aff(Someone)>=30 · now 25
```

— and a card that shows these lines to its narrator (School v4 does) lets the story steer toward the
beat, so it can fire in the very reply the player walks into it. A moment written into PREREQ is
invisible to that.

### Chaining a series

Every row is a one-shot. When it fires, the engine marks it done at its own marker — beside the card's
trigger table, at `<trigger root>.fired.<key>` (School v4: `EventPack.fired.<key>`) — and never deletes
that marker. A series orders its beats on it:

- the opener carries no `prereq`; its marker is what stops it firing twice;
- every later beat's `prereq` is `flag:<previous key>`.

Never order a chain on anything a beat wrote — a quest record's `Step`, a stamp on that record. The
card may delete or reset it (School v4 deletes a completed quest at the day's settle), and every later
beat is then closed for good. The installer warns when more than one row of a series carries no
`flag:`. For a pause between beats, read the marker's own stamp:
`flag:paulk_riverarc_1 & DaysSince(EventPack.fired.paulk_riverarc_1.at)>=1` waits for the game-day
after step 1 (School v4's spelling). A `flag:` may name any key, so the same token chains on another
pack's beat.

### WHEN-DSL (`prereq`, `when`, and each `whenAny` alternative)

Join conditions with `&` (AND). Recognized token forms:

| Form | Example | Meaning |
|---|---|---|
| comparison | `Aff(Yuki)>=40`, `T>=16:00`, `Mainchar.Money>=500` | `>=` `<=` `>` `<` `=`/`==` — numeric when the right side is a number, else string compare (ISO dates and `HH:MM` sort correctly) |
| raw path | `Mainchar.Energy_curr>=20` | any dotted `stat_data` path resolves directly; a path that does not exist reads as 0 in a numeric compare |
| `DaysSince(path)` | `DaysSince(EventPack.fired.x_y_1.at)>=1` | whole game-days since the stamp stored at that path; an empty stamp reads as never (a `>=N` cooldown opens, a `<=N` recency gate stays shut); a path that exists nowhere also reads as never but the engine WARNS — put it after the token that proves the record exists |
| set membership | `Wkd in {Saturday,Sunday}` | ONE value equals any of the listed ones |
| presence | `Present(Yuki)` | that character is in the scene — by their KEY |
| flag | `flag:met_leila` | an earlier event already fired (the engine marked it done when it fired) |
| contains | `contains(Classmate.*.Mood, "Excited")` | the value holds this text, case-sensitive |
| has | `has(Classmate, "Mitsuki")` · `has(Mainchar.Inventory, "camera")` | the collection holds this entry — over KEYS for a record, VALUES for a list |
| `!` | `!Present(Yuki)` | NOT — inverts that one token |
| `*` | `Classmate.*.Mood` | any entry of a collection; zero matching entries is FALSE, never true |
| empty | `''` or `-` | always true |

Details that bite:

- **Everything is case-sensitive.** `contains(…, "excited")` misses `Excited`; `Present(mitsuki)` misses
  `Mitsuki`.
- **`Present()` takes the KEY** a character is stored under: `Present(Mitsuki)`, never
  `Present(Mitsuki Tachibana)` — a display name is prose the engine never reads.
- **`in` is for values, not collections.** `Classmate in {…}` is never true; membership is `has()`.
- **`has` vs `Present`.** `has(Classmate, "Mitsuki")` = she is on the roster at all (usually PREREQ);
  `Present(Mitsuki)` = she is in the scene now (usually WHEN).

Genre sugar (e.g. School's `Aff(X)`, `Stage(X)`, `Quest(X).Step`, `Wkd`, `T`, `Loc`) is a SPELLING of a
path the card declares (`Aff(X)` is `Classmate.X.Affection`); pick from the forms its engine declares
(`EVENT_PACK_ADAPTER.aliases` + `.sugar`), which is what the builder offers with each alias shown beside
its expansion — you may write either spelling. An unknown scalar never errors, but it is NOT simply
false: a numeric compare reads it as 0 and a string compare as the literal text, so `Unknown>=1` never
arms while `Unknown<=3` ALWAYS does. The validator warns on malformed token SHAPES only.

### fx — what the fire records, writes and pays

| fx field | Shape | Effect |
|---|---|---|
| `summary` | string | the row's LABEL — what the pack tab shows you. Nothing writes it into the save (§5 says how a beat reaches the card's world log) |
| `scope` | one of the values the card declares (School v4: `arc` \| `save`) | stored as written on the row's done-marker; the CARD decides what it means (School v4: `save` = once for the life of the save; `arc` or omitted = may fire again after the story loops). A value the card does not declare is warned at install |
| `writes` | `[{ path, key?, set?, add?, remove? }]` | the state the fire changes, applied by the engine under the card's declared rules |
| `reward` | `{ kind: { field: amount } }` | the row's own payout (format 1.1), only in a kind the card's engine declares, held to that kind's ceiling |

Nothing else exists under `fx`: any other key is reported and ignored. The engine records the
done-marker itself — there is no `fx.flag`.

**Writes.** One write is one record:

| Write field | Meaning |
|---|---|
| `path` | a path the CARD opened. The installer's refusal names the ones it allows, and the builder offers only those |
| `key` | the record inside that collection — any key nobody has claimed; absent for a plain object; never containing `.` or `/` |
| `set` | field → value, written as given under the card's OWN field names (`Step`, `Title`, `Rel` — the names its schema uses, never a pack-side alias) |
| `add` | field → numeric delta, only on a field the card's rule allows |
| `remove` | `true` deletes the record, only where the card allows it |

**A pack writes only records it owns.** It may create any record key nobody has claimed, and the engine
stamps the pack's id on it; it may overwrite or remove only a record its own id stamped, so an official
quest, a record the narrator or the player made, or another pack's record is out of reach. On a path
the card shares as a registry (`fillOnly`), a pack names the record the world already uses
(`School_Cafeteria`, not a duplicate of it) and only fills its blank fields; removal is never shared.

The card adds what its rules say on every write — a type, a clock stamp, the owner — and drops a field
it locks (`WRITE FIELD DROPPED (locked)`) while the rest of the write lands. A field whose name starts
with `_` is never written. Writes run in the order given; two writes to one record in one row land in
sequence. A row with no `writes` is a complete event: it plays, it is marked done, nothing else moves.

A write the card does not allow — a path it does not open, or one that cannot record who made a
record — is refused at install, warned on every chat load, and refused again when the event fires. The
event still plays and is marked done; only that write is dropped.

**Rewards.** A `reward` kind is either paid to the path itself (`{ "kind": { "Field": 5 } }`) or, where
the card declares the kind KEYED, to one member the row names (`{ "kind": { "MemberKey": { "Field": 5 } } }`).
A member may also be a selector, `<path>.*.<field>`, meaning "whoever that field marks" — exactly one
(format 1.2). A kind the card writes as TEXT takes a string, which replaces the field. An amount over
the kind's ceiling is paid at the ceiling and logged, and a reward pays only a member who already
exists. The kinds, their shapes and their ceilings are the card's own (its engine's `rewards` list); the
install refuses a kind the card does not pay, or one asked for in the wrong shape.

Which fields each of the card's paths accepts, which ones its engine fills on its own (`Type`,
`LastUpdated`, …) and which reward kinds it pays are the card's documentation — School v4:
`Schoolv4/doc/event-pack-adapter.md`.

## 5. Bodies (DO / FIRE)

- Gate each body with exactly `=== '@<key>'` (note the `@`; the key inside the JSON has none).
- `DO` = the prose the narrator plays on the reply the event arms. What works: a short, concrete
  slice — who does what, in one or two sentences of direction — plus what must NOT happen ("do not add
  characters, do not skip time, resolve nothing").
- `FIRE` = tells the narrator to emit `/Intent/eventFire "<key>"` (append `:Outcome` when the body
  branches on an outcome) — THAT is what makes the engine apply `fx`. FIRE text itself changes nothing.
- Prose changes no state. A beat that should raise a stat plays a moment the card's own rules pay for,
  or the row pays it in `fx.reward`. The engine writes no prose either: if the beat belongs in the
  card's world log, ask the narrator for it in FIRE (School v4: `emit /Intent/recordEvent "arc|<one line>"`).
- Every trigger key needs a matching gate + eventFire emit in the pack's own text, or the event arms
  and renders nothing, or plays and never fires. The installer refuses such a pack.

## 6. Compatibility (`format`)

`format` declares which DSL/format contract the pack needs — bump-rules live with the engine:

- Pack format MAJOR **above** the card's engine ⇒ install is blocked ("update the card").
- Same MAJOR, newer MINOR ⇒ installs with a warning; unknown optional extras are ignored.
- Current contract: **1.2**. Everything in §4 is 1.0, except `fx.reward` (1.1) and a reward member
  named by a selector (1.2).

`format` ≠ `version`: `format` is the contract level, `version` is YOUR content revision.

## 7. Trust & safety (what a pack can NEVER do)

- Installing a pack writes ONLY into the trigger table the card's engine declares (School v4:
  `EventPack.triggers`) and the install record beside it — definitions, never live state — and only
  trigger keys carrying the pack's own prefix are accepted (collisions with official or other packs' keys
  reject the pack).
- When an event FIRES, its `writes` reach only the paths the card's engine declares, under the rules it
  declares, and only records the pack itself made or that nobody has claimed — the official rows are
  out of reach. Its `reward` pays only the kinds the card declares, up to their ceilings. A write is data
  the shared engine applies; a pack cannot express a code path.
- The EJS lint keeps installed entries code-free; live game state (quests, fired flags, stats) is
  never written by install/upgrade/uninstall — only event DEFINITIONS move. The one exception: when an
  uninstall, a disable or an upgrade removes the event the card's armed pointer names, the pointer is
  emptied, so the next reply is not told to play a body that is gone.
- A card upgrade never touches your rows. The card's own events are rows in the same table, seeded from
  its `[InitVar]`. When the card's GameLogic Pack pushes changed ones into running chats
  (`state.forceFromInitVar`, `gamelogic-pack-format.md` §8), it replaces only the rows the card carries —
  keys your prefix never collides with — and deletes no row, so every row a player installed, from any
  author, stays. A pack chained on an official event (`flag:<official key>`) follows that event's current
  gate.

## 8. Worked example — a 2-step series

```
<%_ if (false) { _%>
<mvueventpack>
{
  "format": "1.0",
  "creator": "paulK",
  "event": "RiverArc",
  "version": "1.0",
  "triggers": {
    "paulk_riverarc_1": {
      "cat": "TRG", "series": "RiverArc",
      "when": "Wkd in {Saturday,Sunday} & T>=10:00 & Aff(Yuki)>=40",
      "fx": {
        "summary": "Yuki suggests a day at the river; opens the quest.",
        "scope": "arc",
        "writes": [
          { "path": "Mainchar.Quests", "key": "paulk_riverarc_quest",
            "set": { "Step": 1, "Title": "River Day", "Status": "On-going",
                     "Desc": "Yuki wants a day at the river.", "Objective": "Go to the river with Yuki.",
                     "ProgressSummary": "Invitation accepted.", "Reward": "?" } }
        ]
      }
    },
    "paulk_riverarc_2": {
      "cat": "TRG", "series": "RiverArc",
      "prereq": "flag:paulk_riverarc_1",
      "when": "Loc=Outskirts_River & Present(Yuki)",
      "fx": {
        "summary": "The river day with Yuki; completes the quest.",
        "scope": "arc",
        "writes": [
          { "path": "Mainchar.Quests", "key": "paulk_riverarc_quest",
            "set": { "Step": 2, "Status": "Completed", "ProgressSummary": "River day resolved.", "Reward": "A summer memory." } }
        ]
      }
    }
  }
}
</mvueventpack>
<%_ } _%>
<%_ if (getvar('stat_data.EngineDerived.EventArmed[0]') === '@paulk_riverarc_1') { _%>
<Event_Pack>
@paulk_riverarc_1  River Day ·1   (CHECK - )
  DO  Yuki catches {{user}} with her phone out, weather app open — a perfect forecast for the day.
    She wants ONE full day at the river, just the two of them. Play her pitch; let {{user}} commit or wriggle.
  FIRE  emit /Intent/eventFire "paulk_riverarc_1" → the engine opens the River Day quest at Step 1.
</Event_Pack>
<%_ } _%>
<%_ if (getvar('stat_data.EngineDerived.EventArmed[0]') === '@paulk_riverarc_2') { _%>
<Event_Pack>
@paulk_riverarc_2  River Day ·2   (CHECK BONDING · final step)
  DO  The river day itself — play the set-piece to fit the route so far. End the beat on how close
    the two actually got.
  FIRE  emit /Intent/eventFire "paulk_riverarc_2:Outcome" (Outcome = the BONDING tier of the beat) →
    the engine completes the River Day quest.
</Event_Pack>
<%_ } _%>
```

## 9. Install and verify

1. Paste the text into the **Event Packs** tab → **Validate** → **Add & install**. The installer checks
   identity, keys, bodies, grammar, writes, rewards and `format` against the card that is loaded.
2. On the live card, watch the pipeline log:
   - `EVENT ARMED -> @paulk_riverarc_1` — the conditions hold, and the body is offered this reply;
   - `EVENT FIRED: paulk_riverarc_1`, with a `WRITE <path>.<key> (new) <- <fields>` line per write and
     an `EVENT REWARD (…)` line per payout — the narrator played it and the effects landed;
   - `EVENT FIRE REJECTED (verify-at-fire…)` — the narrator reported a fire the state does not back,
     and the engine refused it;
   - `WRITE REFUSED (…)`, `WRITE FIELD DROPPED (…)`, `REWARD REFUSED (…)` — each names what was dropped
     and why.
3. A fired row leaves its marker at `<trigger root>.fired.<key>` with `state: "done"` (School v4:
   `EventPack.fired.<key>`).

**Testing a negative condition — the canary.** Add a throwaway row whose condition must never hold,
keyed so its `EVENT FIRED` line would stand out (`yourname_yourarc_canary`). A canary that never fires
proves nothing until you have also seen it fire once, by making its condition true on purpose.

## 10. Common mistakes

| Mistake | What happens | Fix |
|---|---|---|
| a later beat gated on what an earlier one wrote (`Quest(X).Step==1`) | the card deletes or resets that record and every later beat stays closed; the installer warns | `flag:<previous key>` |
| the moment (time, place, presence) in `prereq` | the row can still fire, but nothing steers the story toward it | durable state in `prereq`, the moment in `when` |
| `in` with a collection (`Classmate in {…}`) | never true | `has(Classmate, "Name")` |
| `Present(Full Name)` | never true | the character's key: `Present(Mitsuki)` |
| a scope the card does not declare (`Save`, `once`) | stored as written; School v4 treats anything but `save` as `arc`, so the event recurs after the loop; warned at install | a value the card declares |
| expecting DO prose to change a stat | nothing moves | a write, a reward, or a scene the card's own rules pay for |
| `when` and `whenAny` on one row | refused at install | one of them |
| two arcs in one pack | refused at install | a second pack |
| an edit re-installed under the same `version` | refused: already installed | bump `version` |

## 11. Checklist before sharing

- [ ] `creator` / `event` / `version` filled; every trigger key starts with your `creator_event_` prefix
- [ ] one `series` value on every row; ≤ 20 rows
- [ ] the opener has no `prereq`; every later beat's `prereq` is `flag:<previous key>`
- [ ] every key has a gated body + an `eventFire "<key>"` emit
- [ ] only the three sanctioned EJS patterns anywhere in the text
- [ ] conditions use the target card's declared paths or aliases, with the moment in `when` (an unknown
      scalar reads as 0 / its own text, so a `<=` gate against one is always true)
- [ ] every write names a path the card opens and the card's own field names
- [ ] pasted into the Event Packs tab → **Validate** shows "Pack is valid" with no warnings you
      can't explain
