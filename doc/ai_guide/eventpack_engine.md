# Event Packs: quick guide for AI assistants

You are an AI coding assistant in a clone of the `mvu-helper-template` workspace. This page covers 2 jobs. **Part A** writes an event pack: data that adds a story arc to a game. **Part B** makes a GameLogic Engine host event packs: code, done once per game. Read section 1, then the part you need. Paths are relative to the project folder (the one holding `CLAUDE.md`, `package.json` and `workspace/`). You have the workspace, the user's card in SillyTavern (the dev loop installs every save within a second), the console through the Chrome DevTools MCP, and the public docs. You have no MVU Helper source and no MvuGameMaker repo: never ask for or point at a private path.

## 1. Hard rules

1. **A pack is data, the engine is code.** A pack never carries logic. An engine never carries per-pack code.
2. **`eventpack.cjs` is one shared library.** Never edit it, never re-implement any part of it (grammar, tie-break, writes), never type it from memory or from these docs. To update, replace the whole file.
3. **A save under `workspace/` is a deploy.** Write a new pack outside `workspace/` and move the folder in when it is complete.
4. **Keys are identity.** Never rename a trigger key once anyone has played it. Bump `version` instead.
5. **Every key** is `a-z 0-9 _` only, starts with the pack prefix, has exactly one gated body, and its FIRE line contains `eventFire "<key>`.
6. **Only 3 EJS shapes** may appear anywhere in a pack (section 3.2). Anything else refuses the whole file.
7. **The armed pointer is a `[value, label]` pair.** Every body gate reads `[0]`.
8. **A series chains on `flag:<previous key>` only.** Never on a record a step wrote: the game may delete it.
9. **Prose changes no state.** Only `fx.writes`, `fx.reward` and the done-marker do.
10. **The narrator only reports.** It writes `"<key>"` or `"<key>:<Outcome>"` to `/Intent/eventFire`. The engine verifies the conditions again and commits.
11. **In `contains()` and `has()`, write the raw path, never a shortcut** (section 3.5).
12. **Every refusal and drop is logged by name.** Read the log, never guess. Never write `stat_data` from the console without asking the user: steer the story instead.

## 2. Where things live

| Thing | Where |
| --- | --- |
| a pack in development | `workspace/<pack-id>/pack.json` + `workspace/<pack-id>/events/<name>.txt` |
| the sample pack | `workspace/evenpack-test-series/`: an ArtificKoi probe (see 3.1) |
| the library, and how to wire it | `workspace/gamelogic/engine/eventpack.cjs`, `workspace/gamelogic/engine/README.txt` (host only) |
| installed pack text | lorebook entry `[MVU_Event_Pack] <pack id>`, plus `[MVU_Event_Pack_Registry]` |
| the rows the engine reads | `stat_data.<triggerRoot>`, e.g. `EventPack.triggers` |
| which pack owns which rows | `stat_data.EventPack.installed.<pack id>.keys` (beside `triggers`) |
| done-markers | `stat_data.EventPack.fired.<key>` = `{ state: "done", scope, at }` |
| the armed pointer | `stat_data.<armedPath>`: `["@<key>", "label"]` or `["", "label"]` |

## 3. Part A: author an event pack

### 3.1 The folder

`workspace/paulk-beach-arc/pack.json` + `workspace/paulk-beach-arc/events/paulk-beach-arc-event-pack.txt`, with:

```json
{ "format": "1.0", "packType": "eventpack", "id": "paulk-beach-arc", "name": "Beach Arc",
  "description": "Event pack Beach Arc v1.0", "version": "1.0" }
```

- `id` = the pack id with dashes: `paulk.beach_arc` becomes `paulk-beach-arc`. One folder per pack. The dev loop reinstalls on every save, even at the same `version`. The Event Packs tab needs a higher `version`.
- `workspace/` should hold only what belongs on the open card. The dev loop offers to install the WHOLE workspace there, and the blank `gamelogic/` must never land on another game's card.
- **The sample `evenpack-test-series/` only installs on ArtificKoi.** It gates on `EngineDerived.EventArmed`, writes into `Mainchar.Quests` and `WorldRecord.*`, pays an `appearance` reward and uses ArtificKoi's `Loc` shortcut. On any other card the install is refused. Read it as a format example. Its canary row is meant to never fire.

### 3.2 The events file

One file holds one or more packs. Each pack is a hidden JSON block, then one gated body per key:

```
<%_ if (false) { _%>
<mvueventpack>
{ "format": "1.0", "creator": "paulK", "event": "Beach Arc", "version": "1.0",
  "triggers": { "paulk_beach_arc_invite": { ... }, "paulk_beach_arc_day": { ... } } }
</mvueventpack>
<%_ } _%>
<%_ if (getvar('stat_data.EngineDerived.EventArmed[0]') === '@paulk_beach_arc_invite') { _%>
<Event_Pack>
@paulk_beach_arc_invite  Beach Invite ·1
  DO  Mitsuki catches {{user}} after class and asks for one beach day, just the 2 of them. Play her
      pitch and let {{user}} answer. Do not skip time, do not add characters.
  FIRE  emit /Intent/eventFire "paulk_beach_arc_invite" -> the engine opens the Beach Day quest.
</Event_Pack>
<%_ } _%>
```

The 3 legal EJS shapes are exactly the ones above: `<%_ if (false) { _%>`, `<%_ if (getvar('stat_data.<armedPath>[0]') === '@<key>') { _%>`, `<%_ } _%>`. `EngineDerived.EventArmed` is ArtificKoi's armed path. Use the host's. A wrong path is refused and the message names the right one.

### 3.3 Identity and limits

| Field | Rule |
| --- | --- |
| `creator`, `event` | required. Slugged: lowercase, spaces to `_`, only `a-z 0-9 _` survive. At least one latin letter or digit each. `creator` may not contain `official` |
| `version` | required, `1.0` or `1.2.1`. Bump on every shared change |
| `format` | required. `1.0` for conditions, `whenAny`, `writes`. `1.1` if any row has `reward`. `1.2` if a reward names its member by selector. Declaring too low is refused with the number to use |
| `builtWith` | optional receipt, never checked |
| pack id / key prefix | `slug(creator).slug(event)` / `slug(creator)_slug(event)_`, e.g. `paulk.beach_arc` / `paulk_beach_arc_` |
| caps | 20 rows per pack, 4 KB JSON per row, 64 KB text per pack, one `series` value per pack. A second arc is a second pack. Several packs in one file install together or not at all |

### 3.4 Trigger rows

| Field | Meaning |
| --- | --- |
| `cat` | `TRG` (default choice) or `TIME` (clock or calendar beat). When 2 rows are ready, `TIME` wins, then the row with more tokens (`prereq` + the `when` alternative that holds), then the earlier row |
| `series` | the arc name. Optional: a row without one is a one-shot |
| `prereq` | is the event on the table: durable story state, AND only. `""`, `-` or absent = none |
| `when` | is this the moment: time, place, who is present |
| `whenAny` | instead of `when`: a list of AND-strings, any one is enough. Never both |
| `fx` | `summary` (a label, never written to the save), `scope`, `writes`, `reward`. Other keys are warned and ignored |

Keep the moment in `when`. MVU Helper's PRE candidate list shows rows whose `prereq` holds and whose `when` is exactly ONE token short (`<key> · need <token> · now <value>`), so the story can steer to it. Put cooldowns in `prereq`, where no player line is asked to satisfy them. ArtificKoi's step pattern: `"prereq": "flag:mitsuki_2 & DaysSince(EventPack.fired.mitsuki_2.at)>=7"`.

### 3.5 Condition grammar

Tokens joined with ` & `. `""` or `-` = always true.

| Token | Example | True when |
| --- | --- | --- |
| compare | `Aff(Mitsuki)>=40`, `T>=16:00`, `Loc=School_Gate` | ops `>= <= > < = ==`. A number on the right (`-?\d+(\.\d+)?`) compares numbers, anything else compares text (zero-padded `HH:MM` and `YYYY-MM-DD` sort right) |
| in set | `Wkd in {Saturday,Sunday}` | the left value equals one item |
| Present | `Present(Mitsuki)` | the host's `presence` path, with `*` = that KEY, is `true`. Never a display name |
| flag | `flag:paulk_beach_arc_invite` | that key's done-marker is `done` |
| contains | `contains(Classmate.*.Mood, "Excited")` | the text holds the substring, case-sensitive |
| has | `has(Mainchar.Inventory, "camera")` | a record has that KEY, a list has that VALUE |
| not | `!Present(Airi)` | flips one parsed token |
| DaysSince | `DaysSince(EventPack.fired.x_y_1.at)>=1` | whole game days since the stamp at that path (needs the host's `daysSince`) |

Left side lookup order: `DaysSince(path)` > host shortcut (`adapter.aliases`) > host computed name > raw path relative to `stat_data` (no `stat_data.` prefix) > the text itself. `[value, label]` pairs are unwrapped.

Traps, each verified against `eventpack.cjs`:

- **A name that resolves to nothing:** a number compare reads 0, a text compare reads the name itself. `Typo>=1` never holds, `Typo<=3` always holds.
- **`*` fans out only inside `contains()` and `has()`.** There it means any entry, and zero entries is false. In a compare or `in`, `Classmate.*.Affection>=40` reads the literal path and is false.
- **`contains()` / `has()` take a plain left side as a raw path, with no shortcut expansion.** `has(MC.Inventory, "camera")` and `contains(Loc, "School")` are always false. Write `has(Mainchar.Inventory, "camera")`. Paren shortcuts like `Trait(Mitsuki).Mood` do expand.
- **`in` is for values.** `Classmate in {Mitsuki}` is never true. Membership is `has(Classmate, "Mitsuki")`.
- **An unparseable token is false, even under `!`.** `!!x` is unparseable.
- **`DaysSince`:** an empty stamp, or a host with no clock, reads as never. `>=N` opens at once, `<N` never holds. A path that does not exist warns. Put it after the `flag:` that proves the marker exists.
- **Unspellable:** `&` anywhere, operator characters inside either side, `{}()` in a compare's right side, `,{}` inside a set item, `()` inside a Present name, line breaks.
- **Builder spelling:** no spaces around operators, set items without spaces. The engine trims, so `{OPEN, FREE}` works too.

### 3.6 fx: writes, reward, scope

```json
"fx": { "summary": "Opens the Beach Day quest.", "scope": "arc",
  "writes": [ { "path": "Mainchar.Quests", "key": "Beach_Day", "set": { "Step": 1, "Status": "On-going" } } ],
  "reward": { "heroine": { "Mitsuki": { "Affection": 10 } } } }
```

- A write is `{ path, key?, set?, add?, remove? }`. `path` must be one the host's `writes` opens. `set` uses the host schema's own field names. `add` only on fields the host lists. `remove: true` only on a removable path. A key never contains `.` or `/`. A field starting with `_` is never written.
- A pack may create any unclaimed key (no prefix needed) and may change or remove only records its own id stamped. On a `fillOnly` path (a shared registry) it names the world's existing key and can only fill blanks.
- `reward` pays only kinds the host declares, capped at the host's ceiling. A keyed kind names an existing member, or a selector like `Classmate.*.Is_present` (format `1.2`).
- `scope` is stored on the done-marker and the host decides what it means. Use only values the host declares (ArtificKoi: `save` = once ever, `arc` or empty = can fire again after its time leap). A row with no writes and no reward is valid: it plays once and is marked done.

ArtificKoi's paths, rules and reward ceilings are listed on [Writes and rewards](../eventpack_engine/writes.md). Its shortcuts are on [The condition language](../eventpack_engine/dsl.md).

### 3.7 Bodies

- One body per key, gate `=== '@<key>'` (the `@` is in the gate only, never in the JSON key).
- `DO`: a short, concrete slice of who does what, plus what must NOT happen (no time skip, no new characters, resolve nothing). ArtificKoi's narrator may cameo anyone in a body, but a gate must never need them.
- `FIRE`: `emit /Intent/eventFire "<key>"`, or `"<key>:<Outcome>"` when the beat branches. Text after `->` is only a note.
- A beat worth remembering asks the narrator for the host's memory channel in FIRE (ArtificKoi: `emit /Intent/recordEvent "save|<one line>"`). The engine writes no prose.

### 3.8 Builder or by hand

MVU Status Menu Builder's Event Pack tab is a GUI the USER runs: it reads the host card file, offers only that game's conditions, paths and fields, and gives Download artifact .zip (the folder in 3.1). You cannot run it. Either the user builds and you review the extracted folder against this page (keep edits in builder spelling, or its Load refuses the file), or you hand-write from the shapes above, copying every path, shortcut and field name from the host's contract, never from memory.

### 3.9 Deadlocks: a series is a chain

Each step waits on the previous step's done-marker. One gate that can never hold freezes every later step, and nothing is logged: an impossible event looks exactly like one whose turn has not come, and the candidate list only speaks for rows one token short. Check every row:

| # | Freezes the chain | Example | Fix |
| --- | --- | --- | --- |
| 1 | a location key the game does not have | `Loc=School_Rooftp` | copy keys from the game's location list |
| 2 | a time window with no minutes | `T>=18:00 & T<=09:00` | fix the bounds |
| 3 | a place reachable only while it is closed | a shop gated `T>=21:00` | open the window inside its hours |
| 4 | `flag:` naming a missing row, the row itself, or a later row | | name an earlier row that exists |
| 5 | a gate needing a character the player may never meet | `Present(Airi)` in Mitsuki's series | gate on the series' own character only |
| 6 | a stage set closed at the top, or floored on the top rung | `Stage(Mitsuki) in {Friend}` | list every rung from the floor up |
| 7 | a floor above the stat's ceiling | `Aff(Mitsuki)>=120` on a 0-100 stat | stay inside the range |
| 8 | an exact date or time the player can skip | `Date=2026-04-09` | use `>=` floors |
| 9 | a recency check on a stamp that stays empty | `DaysSince(...)<1` on a host with no clock | needs `nowStamp` and `daysSince` on the host |
| 10 | the place list misses where the beat ENDS | body walks to the rooftop, `when` lists only the classroom | list every place the body can end in |
| 11 | a gate on a record a step wrote | `Quest(Beach_Day).Step==1` | `flag:` |

Row 10 is because verify-at-fire re-checks `prereq` and `when` on the state at the END of the reply (and on the starting state only when the host passes it, see 4.3). Rows 1 to 7 are the 7 checks ArtificKoi's own gate test runs.

An Affection floor needs an "already past it" alternative when the host resets Affection on a stage advance, as ArtificKoi does (`mitsuki_3`): `"whenAny": ["<place> & Classmate.Mitsuki.Affection>=30", "<place> & Classmate.Mitsuki.RelationshipStage in {Dating, Girlfriend, Friends_With_Benefits, Loyal_Puppy}"]`.

Static check before every save into `workspace/` (run with `node`, keep it outside `workspace/`):

```js
// node check_pack.cjs <events file>: prefix, gate, emit, when/whenAny, flag order
const fs = require('fs');
const text = fs.readFileSync(process.argv[2], 'utf8');
const slug = (s) => String(s).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
for (const m of text.matchAll(/<mvueventpack>([\s\S]*?)<\/mvueventpack>/g)) {
  const p = JSON.parse(m[1]);
  const prefix = slug(p.creator) + '_' + slug(p.event) + '_';
  const keys = Object.keys(p.triggers);
  keys.forEach((k, i) => {
    const r = p.triggers[k], bad = [];
    if (!k.startsWith(prefix) || /[^a-z0-9_]/.test(k)) bad.push('needs prefix ' + prefix + ' and a-z0-9_ only');
    if (!text.includes("=== '@" + k + "'")) bad.push('no gated body');
    if (!text.includes('eventFire "' + k)) bad.push('no eventFire emit');
    if (r.when !== undefined && r.whenAny !== undefined) bad.push('both when and whenAny');
    for (const f of String(r.prereq || '').match(/flag:\w+/g) || []) {
      const j = keys.indexOf(f.slice(5));
      if (f.slice(5).startsWith(prefix) && (j < 0 || j >= i)) bad.push(f + ' is missing, later or itself');
    }
    console.log((bad.length ? 'FAIL ' : 'ok   ') + k + (bad.length ? ': ' + bad.join('; ') : ''));
  });
}
```

### 3.10 Workflow A

1. **Get the host's contract:** armed path, shortcuts, presence path, writable paths and their fields, reward kinds, scopes, format. Your own engine: read `EVENT_PACK_ADAPTER` in `workspace/gamelogic/engine/`. ArtificKoi: the pages linked in 3.6, armed path `EngineDerived.EventArmed`, format `1.2`. Any other card: the builder's badges, or install once and read the refusal, which names the armed path and the allowed write paths. Verify: you can name every path your rows read or write.
2. **Write the pack outside `workspace/`:** rows first (3.4 to 3.6), then bodies (3.7). Verify: the static check prints `ok` for every key, and every row passes the table in 3.9.
3. **Move the folder into `workspace/`.** Verify: the dev server terminal shows `✓ <folder> [eventpack "<id>"]`. That checks only that `events/` has a file. The real checks run in the browser.
4. **Read the install result.** Verify: the dev loop pill says Connected with your pack counted as applied, the console has no `[artifact-dev-loop] activation refused for "<id>"` line, and `EventPack.installed.<pack id>.keys` lists your keys (section 5).
5. **Arm the first step** by playing toward its gate, one turn at a time. Verify: `EVENT ARMED -> @<key>` in the `[logic-engine] [RES]` line, and the armed pointer reads `["@<key>", ...]`.
6. **Fire it:** the narrator plays the body and reports. Verify: `EVENT FIRED: <key>`, one `WRITE ...` line per write, `EventPack.fired.<key>.state` is `done`, the pointer is back to `""`.
7. **Walk every step to the end.** On a host wired per 4.3, a step never arms in the reply the previous one fired: expect it on the next reply at the earliest.
8. **Release:** bump `version`, share the events file. Players use MVU Helper > Event Packs > Load file > Validate > Add & install.

## 4. Part B: host event packs in a GameLogic Engine

### 4.1 Load the library

**Getting `eventpack.cjs` today.** There is no public download yet: `engine/README.txt` says the link is "to come", and [Host event packs](../eventpack_engine/host.md) points back at that README. So ask the user for the file (the MVU Helper author distributes it). Never write, rebuild or paste one together, and never cut it out of another card's `[MVU_LogicEngine]` entry: that entry is several files joined with no separator. Until the file arrives you can write everything else in 4.2 to 4.6. Keep `engineOrder` at `["gameLogic.cjs"]` and keep the `EVENTS` null guard: the engine then logs `eventpack.cjs is not loaded` each turn and nothing arms.

When you have it: save it as `workspace/gamelogic/engine/eventpack.cjs`, byte for byte, then in `pack.json`:

```json
"engineOrder": ["eventpack.cjs", "gameLogic.cjs"]
```

- Every `.cjs` in `engine/` must be in `engineOrder` and every name there must exist, or the assembler refuses the pack. README files are ignored.
- The files run as one script, in order. `eventpack.cjs` declares no top-level names and leaves its API on `globalThis.__EVENTPACK__`. It also sets `module.exports` when it runs, so your file must assign `module.exports = { ... }` as one whole object.

### 4.2 The adapter

Start from the `gameLogic.cjs` in `engine/README.txt`: it runs as written. Then declare what your game has:

| Key | Needed | Declares |
| --- | --- | --- |
| `triggerRoot` | yes | dotted path of the row table, e.g. `EventPack.triggers`. `installed` and `fired` live beside it |
| `armedPath` | yes (MVU Helper and the builder read it) | dotted path of the armed pointer. Every body gate uses it |
| `get(value, default)` | yes | unwrap your stored values (`[value, label]` pairs) |
| `getArmed(sd)` / `setArmed(sd, v)` | yes | read and write the pointer: always a string `'@key'` or `''`, label kept |
| `warn(message)` | yes | where library warnings go. The library throws without it |
| `writes` | for writes | `[{ path, ownerStamp, fixed, stamp, locked, monotonic, fillOnly, add, clamp, removable, removeAtZero, capacity }]` |
| `rewards` | no | `[{ name, path, keyed, fields, clamp, max }]`, or `{ ..., text: true, maxLength }` |
| `scopes` | no | the scope words your game gives a meaning to |
| `aliases` | no | shortcuts as data: `{ 'Aff(*)': 'Cast.*.Affinity', Loc: 'World.Location' }` |
| `presence` | for `Present()` | e.g. `'Cast.*.Is_present'`, tested `=== true` |
| `resolveScalar(sd, name)` + `sugar` | no | a name that genuinely computes. Return the name unchanged when you do not claim it |
| `nowStamp(sd)` | for stamps | your clock as `'YYYY-MM-DD HH:MM'`. Fills every `stamp` field and the marker's `at` |
| `daysSince(sd, stamp)` | for `DaysSince()` | whole days to the day being played, `null` for a non-stamp |

A missing optional key degrades with a named warning: `Present()` reads false, `DaysSince()` reads never. Additions to README.txt's adapter, using the template's `Cast` root (your own clock fields replace `World`):

```js
const nowStamp = (sd) => String(get(sd.World && sd.World.Date, '')) + ' ' + String(get(sd.World && sd.World.Time, ''));
// inside EVENT_PACK_ADAPTER:
    writes: [ { path: 'Quests', ownerStamp: 'GrantedBy', stamp: 'LastUpdated', monotonic: ['Step'] } ],
    scopes: ['save'],
    aliases: { Loc: 'World.Location', T: 'World.Time', 'Aff(*)': 'Cast.*.Affinity' },
    presence: 'Cast.*.Is_present',
    nowStamp,
    daysSince: (sd, stamp) => EVENTS.civilDaysSince(nowStamp(sd), stamp),
```

- **`writes: []` is not "fires but changes nothing" for every pack.** An install onto it REFUSES any pack whose rows write (`it allows: no writes at all`). Only a pack with no writes installs and fires. README.txt says such writes are "reported at install". The installer actually refuses them. A keyed write path without `ownerStamp` (and not `fillOnly: true`) also refuses packs that write there.
- Export `EVENT_PACK_ADAPTER` and `EVENT_PACK_FORMAT: EVENTS ? EVENTS.FORMAT : null`. Never type the format number. An adapter you never export reads as a game that cannot host packs.

### 4.3 resolveTurn

README.txt's `resolveTurn` is the contract: read `Intent.eventFire`, hand it to `EVENTS.applyEventFire(statData, value, log, EVENT_PACK_ADAPTER)`, clear the channel whether it fired or not, and run `EVENTS.scanEvents(...)` only when nothing fired, so a chain's next step waits a reply. Keep all 4 parts.

- `applyEventFire` takes an optional 5th argument: the state the reply began on. The fire then also passes when the row held there, so a beat the player walks away from still counts. It only helps when your engine, not the narrator's own ops, applies moves (ArtificKoi applies `/Intent/location` itself and passes a `structuredClone` taken before that).
- Run your game's moves BEFORE the fire, so stamps and verify read the final state. Return `applied: true` whenever you fired, cleared or armed, or nothing is saved. Library log lines: `EVENT ARMED -> @<key>`, `EVENT FIRED: <key> (<Outcome>)`, `EVENT FIRE REJECTED (...)`, `eventFire ignored (unknown event)`, `WRITE ...`, `WRITE REFUSED (...)`, `WRITE FIELD DROPPED (...)`, `EVENT REWARD (...)`, `REWARD REFUSED (...)`.

### 4.4 Schema

Declare both roots in `schema/statdata_schema.js`:

```js
EventPack: z.looseObject({
    triggers: z.record(z.string(), z.any()).prefault({}),
    armed: labeledStr,
}).prefault({}),
Intent: z.looseObject({ eventFire: labeledStr }).prefault({}),
```

- `EventPack` must stay open. MVU Helper writes `installed` and the library writes `fired` beside `triggers`. A closed shape strips the done-markers, and every event fires again. Keep rows as `z.any()` (or `.passthrough()`), or `whenAny`, `prereq` and `fx` parts are stripped.
- Every collection in `writes` must keep the `ownerStamp`, `stamp` and `fixed` fields. If a closed record schema strips `GrantedBy`, the pack's own record reads as the story's and its next write is refused.
- The `labeledStr` prefault gives the pointer its pair shape. A plain-string pointer refuses every install and logs an error on each chat load.

### 4.5 Tell the narrator

Add a constant entry pair, e.g. `entries/event_fire.txt` + `entries/event_fire.json` (`"type": "constant"`, the string). Keep it ungated: a same-reply body arrives with no armed pointer set.

```
<Event_Fire>
When an <Event_Pack> block or a [SAME_ROUND_EVENT] block is in this prompt, its DO line is this reply's main beat. Play it now.
Then, in your variable update, write "<key>" (or "<key>:<Outcome>" when the body names one) into the value half of
/Intent/eventFire: the JSON Patch path /Intent/eventFire/0. The key has no @. Without that report the beat is discarded and plays again.
</Event_Fire>
```

### 4.6 Same-reply firing (optional)

Default: an event arms in one reply and plays in the next. To play it in the reply its last condition comes true, read [Pattern 2](../gamelogic_engine/same_reply.md#pattern-2-an-event-that-fires-the-moment-its-ready) and [pickSameRoundEvent](../gamelogic_engine/hooks.md#picksameroundevent). It runs only with Extra LLM Calls on and a PRE call configured.

```js
function sweepCandidateLines(sd) { return EVENTS ? EVENTS.sweepCandidateLines(sd, EVENT_PACK_ADAPTER) : []; }
function readyEvent(sd) { return EVENTS ? EVENTS.readyEvent(sd, EVENT_PACK_ADAPTER) : null; }
function pickSameRoundEvent(statData, ctx) {
    if (!EVENTS) return '';
    const hit = (ctx.preOutputs || []).map((o) => /"eventReady"\s*:\s*"([^"]*)"/.exec(String(o.output || ''))).find(Boolean);
    const key = hit ? hit[1].trim() : '';
    if (!key || key === 'none') return '';
    const ripe = readyEvent(statData);
    const offered = sweepCandidateLines(statData).map((line) => line.split(' ')[0]);
    return ((ripe && ripe.key === key) || offered.includes(key)) ? key : '';   // only keys PRE was offered
}
// export all 3 beside resolveTurn
```

- A `[PRE]` entry shows the offer: `await LogicEngine.sweepCandidateLines(sd)` and `await LogicEngine.readyEvent(sd)`. Always `await`, check `LogicEngine` exists first, prefix top-level names (`_ev...`). Its output contract asks PRE for one field (`eventReady` here, ArtificKoi's name): the offered key, or `none`.
- `readyEvent` returns nothing for an event that is already armed. The armed path delivers it.
- `ctx.sameRoundEventKey` in `resolveTurn` names what was played. Warn when it neither fired nor stayed armed (ArtificKoi logs `SAME-ROUND MISS` / `SAME-ROUND LOST`).

### 4.7 Your game's own events

Seed your own rows in `[InitVar]` under `triggerRoot`, with bodies in your own entries gated the same way. They are never owner-gated. MVU Helper re-applies `[InitVar]` on every chat load, create-only: a NEW row reaches running saves, a CHANGED row does not. Test an edited own row in a new chat, or fix live saves with `state.force` ([State corrections](../gamelogic_engine/state.md)).

### 4.8 Workflow B

1. **Get `eventpack.cjs`** (4.1). Verify: `engine/eventpack.cjs` exists and its banner names `eventpack.cjs` and a grammar version.
2. **Wire `engineOrder`, the adapter, `resolveTurn`, the exports** (4.1 to 4.3). Bump `ENGINE_VERSION`. Verify offline with Node (the library also works under `require`):

   ```js
   require('./workspace/gamelogic/engine/eventpack.cjs');            // sets globalThis.__EVENTPACK__
   const game = require('./workspace/gamelogic/engine/gameLogic.cjs');
   let sd = { EventPack: { triggers: { me_arc_1: { cat: 'TRG', when: '', fx: {} } }, armed: ['', 'Current Event'] }, Intent: { eventFire: ['', ''] } };
   let r = game.resolveTurn(sd, {}); console.log(r.log);              // [ 'EVENT ARMED -> @me_arc_1' ]
   sd = r.statData; sd.Intent.eventFire[0] = 'me_arc_1';
   r = game.resolveTurn(sd, {}); console.log(r.log);                  // [ 'EVENT FIRED: me_arc_1' ]
   ```

   Load a real pack's rows the same way to walk a chain and test every gate in 3.9. Without an `installed` record the library treats rows as the card's own, so the owner gate is off in this test.
3. **Schema and narrator entry** (4.4, 4.5). Verify: `npm test` passes (EJS scope scan), the dev server shows `✓ gamelogic`.
4. **Live check.** Verify: `MvuHelper.engineInfo().version` is your new `ENGINE_VERSION`, and `stat_data.EventPack.armed` is `["", ...]`.
5. **Install a test pack written for YOUR game** (rewrite the sample: your armed path, your paths, your shortcuts), then run Workflow A steps 4 to 7. Each save re-applies only the folder it touched, and a save with no content change is not re-applied. After an engine change, edit the events file (or bump its `version`) to re-check the pack against the new adapter. Same-reply firing (4.6) comes last, if wanted.

## 5. Checking through the MCP

Ask the user to set MVU Helper > Main tab > Debug log to **Lifecycle** (install lines) and tick Debug domains > **Pipeline** (the `[logic-engine] [RES]` line, which carries your engine's log). Warnings and errors always print. Drive live turns one at a time: wait for the reply and its RES line before the next.

| Look for | Prefix in the console |
| --- | --- |
| dev loop install refused | `[mvu-helper] [artifact-dev-loop] activation refused for "<id>"` |
| chat load sync | `[mvu-helper] [event-pack] <pack id> ...` (`installed`, `skipped`, `NOT installed`, `warnings`) |
| arm, fire, writes | `[mvu-helper] [logic-engine] [RES] <turn>: applied=... → EVENT ARMED -> @<key> \| ...` |

`evaluate_script` snippets:

```js
async () => {   // event state on the newest message (ArtificKoi: the pointer is sd.EngineDerived.EventArmed)
  const chat = SillyTavern.getContext().chat;
  const { stat_data: sd } = await Mvu.getMvuData({ type: 'message', message_id: chat.length - 1 });
  const ep = sd.EventPack || {};
  return { armed: ep.armed, fired: ep.fired, installed: ep.installed, rows: Object.keys(ep.triggers || {}) };
}
```

```js
async () => { const i = await MvuHelper.packInfo(); return { engine: MvuHelper.engineInfo(), eventpacks: i.types.eventpack, disagreements: i.disagreements }; }
```

## 6. Symptom > cause > fix

| Symptom | Cause | Fix |
| --- | --- | --- |
| `no logic engine is loaded on this card` | no engine on the card, or LogicEngine disabled | install the GameLogic Pack, enable LogicEngine |
| `this card's engine declares no EVENT_PACK_ADAPTER` | adapter missing or not exported | export it; re-save the events file after the engine reloads |
| `EJS not allowed ... must read EXACTLY getvar('stat_data.<path>[0]')` | gates use another game's armed path (the sample uses ArtificKoi's), or no `[0]` | rewrite every gate with the path the message names |
| `this card's engine allows no writes into X` ... `it allows: ...` | path not opened, or host has `writes: []` | write to an allowed path, or (host) add the path with `ownerStamp` |
| `declares no ownerStamp on X and does not share it` | host gap | host adds `ownerStamp` or `fillOnly: true` |
| `pays no reward of kind X` | host does not pay it | drop the reward, or host adds the kind |
| `must start with this pack's prefix` / `no eventFire "<key>" emit` | key or FIRE line typo | fix per rule 5 |
| `already installed at vX` (Event Packs tab) | same version | bump `version` |
| installs, never arms, nothing logged | a gate can never hold (3.5 traps, 3.9 table) | read each token's value in `stat_data`, walk it in Node |
| `EVENT ARMED` every reply, body plays, never `EVENT FIRED` | narrator skips the report, writes it without `/0`, or `Intent.eventFire` is undeclared | narrator entry (4.5), schema (4.4) |
| `eventFire ignored (unknown event)` | reported key wrong or carries `@` | key exactly as in the JSON |
| `EVENT FIRE REJECTED (verify-at-fire...)` | the reply left the gate (usually the place) | add every end place (3.9 row 10), or pass the start state (4.3) |
| next step arms in the reply the previous fired | engine scans after a fire | scan only when nothing fired |
| a fired event fires again | `EventPack.fired` stripped, or `eventFire` never cleared | open schema (4.4), clear the channel |
| `WRITE REFUSED (... belongs to the story ...)` on a pack's own record | `ownerStamp` field stripped by the schema, or the key was made by the narrator | keep the field (4.4), use an unclaimed key |
| `EVENT ARMED` logged, body never in the prompt | pointer is a plain string, or gate path differs from `armedPath` | pair shape, matching path |

## 7. Done checklist

- [ ] Every key: prefix, `a-z 0-9 _`, one gated body with `[0]`, one `eventFire "<key>` FIRE line.
- [ ] Only the 3 EJS shapes, gated on the host's real `armedPath`.
- [ ] `format` matches use (`1.1` with any reward), `version` bumped since the last shared copy.
- [ ] One `series` per pack, at most 20 rows, opener without `flag:`, every later step `flag:<previous>`.
- [ ] Every row passed the 3.9 table; cooldowns in `prereq`; no shortcut inside `contains()`/`has()`; no `*` in a compare.
- [ ] Every write path, field, reward kind and scope is one the host declares.
- [ ] The static check prints `ok` for every key.
- [ ] Live: installed, every step seen `EVENT ARMED` then `EVENT FIRED`, `EventPack.fired.<key>.state` is `done`.
- [ ] Host: `eventpack.cjs` unedited and first in `engineOrder`; adapter and `EVENT_PACK_FORMAT` exported; `ENGINE_VERSION` bumped.
- [ ] Host: fire then clear then scan-only-if-not-fired; `EventPack` open; pointer and `Intent.eventFire` declared as pairs; narrator entry present.
- [ ] `npm test` passes.

## 8. The full pages

[What is EventPack Engine](../eventpack_engine/README.md) · [How it works](../eventpack_engine/technical.md) · [The event pack file](../eventpack_engine/file.md) · [Writes and rewards](../eventpack_engine/writes.md) · [Where an installed pack lives](../eventpack_engine/install.md) · [Builder](../eventpack_engine/builder.md) · [Condition language](../eventpack_engine/dsl.md) · [Host event packs](../eventpack_engine/host.md) · [Same reply protection](../gamelogic_engine/same_reply.md) · [Hooks](../gamelogic_engine/hooks.md) · [Schema](../gamelogic_engine/schema.md) · [Development Environment](../dev_env/README.md) · [Macros and API](../macros_api/technical.md)

[Back to QuickStart Guide](../quickstart.md)
