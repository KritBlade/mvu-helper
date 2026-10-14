# A real host: ArtificKoi

This page is ArtificKoi's side of the plugin contract: what it offers a plugin, where its state lives, which of its calls a plugin can share, and its house rules.

It's here for 2 readers. If you write a plugin, this is what one real host looks like. If you write a game, this is the kind of page your plugin authors need from you.

On ArtificKoi, a plugin is a guest. ArtificKoi's engine decides every game outcome. A plugin keeps its own state in its drawer, reads ArtificKoi's state, and adds prompt text next to ArtificKoi's, without changing what ArtificKoi's own calls produce.

## What ArtificKoi declares

ArtificKoi's engine calls itself `School`. That's the name a plugin checks.

| Question | On ArtificKoi | A plugin reads it from |
| --- | --- | --- |
| Which game is this? | `name: 'School'`, `type: 'School'`, `packId: 'school-v4'` | `ctx.engine` in a resolver or `renderPanel`, `MvuHelper.engineInfo()` in EJS, `{{mvuhelperEngineName}}` in plain text |
| Which version? | `ENGINE_VERSION` in `globalLogic.cjs`, bumped on every change | `ctx.engine.version`. Information, never a gate |
| Where is the cast? | `cast@1` > `Classmate` | `ctx.exposes['cast@1']`, or `MvuHelper.exposes()` in EJS |
| Where is the player? | `player@1` > `Mainchar` | same |
| Where is the scene now? | `location@1` > `World.Location` | same |
| Which places has the story named? | `landmarks@1` > `WorldRecord.Locations` | same |
| What has happened? | `chronicle@1` > `WorldRecord.Events` | same |
| What day and time is it? | `clock@1` > `World` | same |

- **These 6 interfaces, and no others.** A plugin that `requires` any other name is refused on ArtificKoi. One that lists it in `optionalUses` installs, and runs without it.
- **An interface only promises its shape:** `Name` for the cast and the player, `Label` for a landmark, `summary` for a chronicle entry, `Date` and `Time` for the clock. See [Exposes](../gamelogic_engine/exposes.md#the-interfaces). Every other field on this page is ArtificKoi's own vocabulary. Read it only behind `engine.name === 'School'`, so the same plugin still runs on a game that keeps its state differently.
- **Most values are `[value, label]` pairs.** `World.Location` is `["Town_BusStop", "Location"]`, `Date` is `["2026-04-08", "Date"]`, and a heroine's `Name` is a pair too. The records in `WorldRecord` are the exception: a landmark's `Label` and a chronicle entry's `summary` are plain strings. `Array.isArray(v) ? v[0] : v` reads both kinds, so use it on every value.
- **`location@1` holds a venue key,** `Area_Venue`, like `School_Rooftop` or `Town_Cafe`. `landmarks@1` only holds the venues the story added during play. The base map lives in a lorebook entry, `Location_List`. So the scene is often at a venue with no landmark.
- **The clock can move backwards.** A time leap restarts the calendar at `2026-04-08`, so a cooldown counted by date difference goes negative across it.
- **A chronicle entry can disappear.** A time leap deletes every entry that isn't kept for the whole save, and the player can trim the log too.

## Game-bound or standalone on ArtificKoi

Both kinds of plugin get the same engine identity and the same matched interfaces here, and everything on this page applies to both.

- **A game-bound plugin** installs when everything it requires is one of the 6 interfaces above.
- **A standalone plugin** installs, and ArtificKoi is just one of the cards it may meet.

A plugin written for ArtificKoi alone is a game-bound plugin. It requires the interfaces it reads, and keeps ArtificKoi's own vocabulary behind `engine.name === 'School'`.

## Reading ArtificKoi's state

**A heroine is keyed by her English key,** like `Mitsuki` in `Classmate.Mitsuki`. ArtificKoi's report channels and logs name her by that key. Key your own records by it too, never by `Name`, which is display text.

**The cast grows during play.** The card starts with one heroine, and the engine adds `Classmate.<Key>` when it builds a heroine the story introduced. A key you haven't seen before is a new heroine, not an error. How that works is Pattern 3 on [Same reply protection](../gamelogic_engine/same_reply.md#pattern-3-a-new-character-the-reply-she-shows-up).

The fields a plugin reads most:

| Path | What it holds |
| --- | --- |
| `Classmate.<Key>.Name`, `.FullName` | her display name and full name |
| `Classmate.<Key>.Location` | where she is now |
| `Classmate.<Key>.Is_present` | `true` while she's in the player's scene |
| `Classmate.<Key>.Affection`, `.RelationshipStage`, `.Mood` | the relationship, as the engine last worked it out |
| `Mainchar.Name`, `Mainchar.Money` | the player |
| `World.Date`, `.Weekday`, `.Time`, `.Location`, `.Weather` | the calendar, the clock and the scene |

The whole shape is in ArtificKoi's schema file, `gamelogic/schema/statdata_schema.js`.

**Which moment your code reads:**

| Your piece | Runs | Reads |
| --- | --- | --- |
| a PRE entry | in the PRE calls, before the narrator | the last reply with state, before the player's message |
| a narrate entry | while the narrator's prompt is built, after the PRE calls | the state the narrator is given |
| a POST entry | in the POST call, after the reply | the reply, after RES1 worked it out |
| `resolveRelay` | RES2, after ArtificKoi's `resolvePostRelay` | the reply, after ArtificKoi's RES2 |

**What `ops` shows here.** ArtificKoi's channels are reports, so a resolver's `ops` holds what each step reported this reply:

- the narrator's channels: `Intent.<channel>`, `by: 'message'`,
- the PRE call's rolls: `Intent.check`, `Intent.fwb`, `Intent.puppy`, `Intent.dayCheck`, `by: 'pre-sim'`,
- the POST call's records: `Intent.relationship`, `Intent.initiative`, `Intent.armClassmate`, `Intent.presentAtEnd`, `by: 'post'`.

The engine's own results aren't ops. RES writes them directly, so read them from `snapshot`. RES also clears the channels it uses, so in `snapshot` a used channel is empty, while `ops` still holds what was reported.

## Its house rules for writing

**Your schema isn't installed here.** ArtificKoi's pack owns the card's `Scheme` script, so install skips your plugin's schema, and ArtificKoi's schema judges every op. See [Whether your schema gets written](writing.md#whether-your-schema-gets-written). ArtificKoi's schema:

- declares `GameLogicPlugin` open, so any key you create inside your drawer is kept,
- closes everything else. The root, `Mainchar`, each `Classmate.<Key>` and `World` are closed objects. A key the schema doesn't name is stripped, and so is a root of your own next to `GameLogicPlugin`,
- stores most fields as `[value, label]` pairs. A pair takes `replace` at `/0`. An `add` at `/0` inserts a third slot, and the op is reverted.

**Write your drawer and nothing else.** Every ArtificKoi root has its own writer, and a plugin isn't one of them:

| Root | Written by |
| --- | --- |
| `Intent` | the narrator, the PRE call and the POST call, as reports. RES reads and clears them |
| `PendingState` | RES, for hand-offs between the steps of a reply, and into the next one |
| `EngineDerived`, `World` | RES, the only writer of the clock and of every worked-out value |
| `Classmate`, `Mainchar` | the engine, from the reports |
| `EventPack`, `EventSpine`, `WorldRecord` | the event engine and its records |
| `Preferences`, `SaveInfo`, `MVUStatMenu_DB_Ver` | the card's settings and menus |

A value a plugin writes into one of these roots skips ArtificKoi's rules. RES may overwrite it on the next reply, or carry on from a state no rule produced. And an op on an `/Intent` channel reads to RES as something the reply did.

When your plugin wants the game to change, say so in prose, in a narrate entry, and let the narrator report what happened on ArtificKoi's channels.

## Sharing ArtificKoi's calls

ArtificKoi's card has 2 calls, `PRE` and `POST`, and the install dialog offers them for your `{PRE_CALL}` and `{POST_CALL}`. Sharing one is the usual case. A call of your own costs one more request per reply, and keeps your prompt away from ArtificKoi's.

**POST.** ArtificKoi's POST instructions (`entries/windows/output-post.txt`) ask for exactly one `<UpdateVariable>` block of its own, and then make room for yours. Another entry routed to the call may ask for its own block, on paths of its own, after ArtificKoi's.

- Ask for your block after ArtificKoi's, in its own `<UpdateVariable>`.
- ArtificKoi's block only writes pairs, always with `replace`. Show as few `add` examples as you can, and say in your block that its verbs are yours. A model that carries your `add` over to `/Intent/armClassmate/0` has that op refused, and the heroine the prose introduced is never built.
- Print no path under `/Intent`. ArtificKoi's block lists the 4 it may write.
- POST only reads the reply's `<maintext>` or `<gametxt>` body. Text the narrator writes outside it never reaches POST.

**PRE.** ArtificKoi's PRE call answers with a JSON verdict first, then one `<JSONPatch>` block. Its output check, `^\s*\{[\s\S]*\}`, needs the verdict to open the output. ArtificKoi's instructions make room for your text and your patch block after the verdict.

- An output that opens any other way, with a preamble, a code fence or a reasoning block, fails the check. MVU Helper then drops the output's prose whole, ArtificKoi's verdict with it. The patch blocks are kept.
- So a PRE entry that asks for prose needs a call of its own. An entry that only adds a short line or a patch block may share ArtificKoi's call, and asks for it at the very end.
- The PRE call writes `/Intent/check`, `/Intent/fwb`, `/Intent/puppy` and `/Intent/dayCheck`. Print none of them.

**The narrator.** An untagged `constant` entry joins the narrator's prompt, next to ArtificKoi's long output instructions (`entries/windows/output.txt`). Keep it short, and use it for what your plugin can compute.

## Dice on ArtificKoi

ArtificKoi deals 2 pools every generation:

| Pool | Dealt in | Dice |
| --- | --- | --- |
| the unnamed pool | `entries/windows/current_variable_data.txt`, for the narrator's checks | 8 d20 |
| `PRE` | `[PRE] check_dc_dice` (`entries/windows/check_dc_dice-pre.txt`), for the PRE call's rolls | 4 d20, 5 when the day's check is due |

Deal yours from a pool with your own name: `MvuHelper.rollPool(1, null, 'WEATHER')`. A call with no pool name, or with `'PRE'`, reads ArtificKoi's pool, and a pool's dice never change inside one generation. So you'd get the same dice ArtificKoi's checks use.

A resolver's `ctx.dicePools` lists ArtificKoi's pools next to yours. Check your die against your own pool.

## When your resolver runs here

Your `resolveRelay` runs once per reply, after the reply's last write. On ArtificKoi that's usually RES2, because ArtificKoi's POST instructions write `/Intent/presentAtEnd/0` on every reply:

1. The POST call returns its block, and MVU Helper applies it.
2. ArtificKoi's `resolvePostRelay` applies `relationship`, `initiative`, `armClassmate` and a skill `record` for the player, and checks `presentAtEnd` against who is present. When nothing POST owns is waiting, it changes nothing.
3. Your `resolveRelay` runs. Its `snapshot` already has step 2 in it.
4. One save carries POST's ops, ArtificKoi's RES2 and every plugin's writes. Its console line names what it carries: `[RES2] saved ✓ -> msg N (POST's ops + engine + plugins)`.

When POST writes no block, because its call failed, timed out or was cut, Extra LLM Calls is off, or the player has no POST call, ArtificKoi's RES2 doesn't run. Your resolver runs after the reply instead, once RES1 is done. Its console line says which: `[RES2] plugin <mid:swipe> alone (POST wrote nothing): …`, or `alone (no POST call this reply)`.

A reply the player stops in the middle isn't recorded, and your resolver doesn't run for it.

## The side panel on ArtificKoi

ArtificKoi's pack declares no side panel slot. So on this card, the side panel only holds the plugins' slots.

A field in your panel reads ArtificKoi's state through an interface you declared (`{cast@1}.…`), or as a raw path (`$.World.Time`) in a plugin written for ArtificKoi. Bind your own drawer for everything that has to show on any card.

## Writing inside ArtificKoi's world

Your entries share prompts with ArtificKoi's, so their text has to agree with the setting:

- **Jinko Academy only admits people aged 18 and over.** Its school life looks like a high school's, and that's all it is. Never call it a high school, or a student a child or a minor. In Chinese it's 學園, never 高中.
- **{{user}} is the only male student.** Every other student is female. Teachers, outsiders and townspeople can be men.
- **A heroine's age, history and personality come from her card entry.** A plugin's text never restates or changes them.

## Testing a plugin against ArtificKoi

1. **Serve it with ArtificKoi.** Put your `plugin-<id>/` folder in ArtificKoi's workspace, next to `gamelogic/`. In the mvu-helper repo run `npm run dev -- <path to the workspace>`, then GameLogic Packs tab > Artifact dev loop > Watch the local dev server. Every save, ArtificKoi's and yours, applies to the open card.
2. **Install it once by hand.** Install to this card, then pick the drawer name and the calls: ArtificKoi's `PRE` and `POST`, or calls of your own.
3. **Play a few replies, then read your drawer.**
4. **Read the console,** with the Pipeline debug domain on:
   - `[mvu-helper] [logic-engine] [RES2] plugin <mid:swipe>: "<id>" landed N/M op(s)` is your resolver's receipt. A warning lists every op that didn't land, with what was sent and what is stored.
   - `[mvu-helper] [engine:plugin:<id>] …` are your engine's own lines.
   - `[mvu-helper] [small-llm] [POST] N/M op path(s) ABSENT after the apply` are POST ops the schema refused.
   - `[mvu-helper] [engine:game] [RES] …` are ArtificKoi's warnings. One that names a channel your text mentions means your prompt leaked into ArtificKoi's reports.

The 2 sample plugins from the [template workspace](install.md#get-a-starting-point) work on ArtificKoi as is. Neither declares `requires`, and both list `cast@1` in `optionalUses`.

## Checklist for ArtificKoi

- [ ] Your plugin's kind is on purpose: `requires` lists every interface it can't run without, or nothing for a standalone plugin.
- [ ] Every ArtificKoi field beyond `Name` is read behind `engine.name === 'School'`.
- [ ] Values are unwrapped from `[value, label]`, and heroines are keyed by their `Classmate` key.
- [ ] A new `Classmate` key in the middle of a chat is handled as a new heroine.
- [ ] Every write stays in your drawer. No op under `/Intent`, `/PendingState`, `/EngineDerived`, `/World`, `/Classmate` or `/Mainchar`.
- [ ] A POST block of yours comes after ArtificKoi's, in its own `<UpdateVariable>`, with as few `add` examples as possible, and a line saying its verbs are yours.
- [ ] A PRE entry that asks for prose has a call of its own. Anything that shares ArtificKoi's PRE call comes after the verdict.
- [ ] Your dice come from your own named pool. Never the unnamed pool, and never `PRE`.
- [ ] Your resolver records a reply where POST wrote nothing, instead of skipping it.
- [ ] Your prompt text agrees with the setting: an adult academy, {{user}} the only male student, and every heroine as her card entry describes her.

[Back to How a GameLogic Plugin works](technical.md) · [Back to index](../../README.md)
