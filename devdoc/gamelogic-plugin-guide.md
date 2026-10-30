# Writing a GameLogic Plugin

A **GameLogic Plugin** is a small, self-contained behaviour you install onto an MVU card. It adds prompt
entries, owns one named subtree of `stat_data`, and can run its own code after POST writes its record. It is
installed from mvu-helper's **GameLogic Packs** tab, beside the GameLogic Pack (the game itself) whose engine it
works with.

A plugin does **not** know the game it lands on. It cannot predict the card's schema, and it cannot guess
what the user named their LLM calls. Everything it needs is either declared in its file or filled in by the
installer. It reads all of `stat_data`, and it can write any path the card's Zod schema allows; the subtree
it *owns* is the one place nothing else writes.

**A plugin comes in two flavors, and `requires` alone decides which.**

- A **game-bound** plugin lists at least one interface in `requires`: it depends on a GameLogic Pack that
  exposes them (§8). Install refuses it, by name, on a card whose game does not expose every one — a card
  with no game included — and it may speak that game's vocabulary behind an engine-name check.
- A **standalone** plugin lists none (`optionalUses` is fine; it runs without them). It installs on any card —
  no game pack, no game engine, nothing but MVU and mvu-helper — discovers what the card offers instead of
  assuming it (§8), and on a card that does have a game it gains everything there with no change to its file
  (§9).

There is no field naming the flavor, so it can never disagree with what install enforces: same `packType`,
same registry, same install. The plugin's library row and card row show it — *standalone*, or *game-bound —
needs* and the interfaces.

Two worked examples live in the MvuGameMaker repository, under `maker-app/GameLogic/Schoolv4/workspace/`.
Both are standalone. `plugin-lane-probe/` is a test harness: all three prompt windows, its own dice pool, and a
drawer that records what each window managed to do. `plugin-standalone-probe/` is the shape this guide asks of a
standalone plugin: a report-only narrate window, one POST window, a resolver and a panel. Reading either probe's drawer
after a few turns tells you which seams work on a card. School v4's side of this contract — what it exposes,
which of its calls a plugin may share, and when a resolver runs there — is `Schoolv4/doc/GameLogicPlugin_Guide.md`.

---

## 1. Build one

1. **Start from a blank plugin.** Development tab → **Add New Blank Packs** → type *GameLogic Plugin*,
   a name, a kebab-case id and a one-line description → **Create archive**. You get a ZIP of a source folder,
   `plugin-<id>/`, that already validates; unpack it into your workspace. Its PRE and POST entries are
   scaffolds that carry no call token yet, so nothing routes them and install asks for no call: add the token
   to the comment when you write one (§2, *The three tokens*), or delete the ones your plugin does not need.
2. **Develop against a live card.** In the mvu-helper repository run `npm run dev -- <workspace>`, where
   `<workspace>` is the folder holding `plugin-<id>/`. In SillyTavern: Development tab → **Artifact dev
   loop** → **Watch the local dev server**. The loop assembles the folder and adds it to the library; on the
   first apply to a card it asks whether that card is a dev card, and from then on applies every save to it with
   no reload.
3. **Install it once by hand.** The dev loop never chooses your call bindings for you: the first install is
   **Install to this card** on the plugin's library row, where the dialog asks for the state root and one
   call per phase your entries use (§3). From then on every save re-applies with those answers.
4. **Ship it.** **Export** on the plugin's card row writes the single-file form (§2) from what is on the
   card, with the call names turned back into tokens.

To import a plugin someone else wrote: **Import** → paste the file (or **Load file**) → **Validate** → **Add
to library**, or **Import source folder** / **Import source ZIP** for the folder form. Then **Install to this
card**. Every refusal names the rule it broke.

---

## 2. The file

One JSON object, the same envelope as the other two artifact types. `packType` routes it.

```jsonc
{
  "format": "1.0",
  "packType": "plugin",            // REQUIRED
  "id": "weather",                 // REQUIRED — kebab-case, unique in the library
  "name": "Weather",               // REQUIRED — shown in the library and the install dialog
  "description": "…",              // REQUIRED — the one line a user reads before installing
  "version": "1.2.0",              // two or three whole numbers; compared on install and for Upgrade
  "builtWith": "hand-authored",    // free-text receipt

  "entries": [ /* prompt entries — §4 */ ],
  "schema":  "…registerMvuSchema…",// REQUIRED — declares the platform roots open, nothing else (§5.4)

  "engine":  "…JS text…",          // optional — §7, runs in the shared Worker
  "panel":   { /* §10 */ },        // optional — the side-panel slot (devdoc/side-panel-format.md)
  "requires":     ["cast@1"],      // optional — §8.2; unmatched ⇒ install refused, by name
  "optionalUses": ["clock@1"]      // optional — §8.2; unmatched ⇒ installs and runs without them
}
```

A plugin has **no `init`** (a file carrying one is refused: a plugin declares no state shape, §5.3) and **no
`regex`** section (it has no card surface of its own to restyle).

### The folder form

The single object is the SHIPPED shape. You author a source folder; the dev loop and **Import source
folder** assemble it:

```
plugin-<id>/
├── pack.json            # the envelope (format, packType, id, name, description, version, builtWith,
│                        #   requires, optionalUses) plus engineOrder — the engine files in load order
├── entries/
│   ├── record.json      # one entry's fields (comment, order, position, type …)
│   └── record.txt       # its content — plain text, no JSON escaping
├── engine/
│   └── relay-resolver.cjs   # becomes "engine" (several files are joined in engineOrder)
├── schema/
│   └── plugin_root_schema.js  # becomes "schema" — exactly one file, REQUIRED
└── panel/
    └── panel.json       # becomes "panel" — optional
```

### The three tokens

Your entries name things the installer fills in:

| Token | Becomes | Why |
|---|---|---|
| `{PRE_CALL}` | `[<the PRE call the user picked>]` | this repo cannot know what the user named their calls |
| `{POST_CALL}` | `[<the POST call the user picked>]` | same |
| `{OWN_ROOT}` | `GameLogicPlugin.<the state root the user picked>` | two copies of one plugin must be able to coexist |

**Using a token IS how you declare the need.** If any entry contains `{POST_CALL}`, the install dialog asks for
a POST call; if none does, it does not ask. If the user has no call configured for a phase you need, install
refuses and says so rather than writing an entry routed to nothing. Any other `{UPPERCASE}` token is warned at
validation, because the installer leaves it as is and it would reach the model verbatim. Lowercase braces
(`{{user}}`, `{name}`) are never touched.

An entry's comment may not contain an installer prefix — `[GameLogicPlugin:`, `[GameLogicPack:`,
`[StatusMenuPack:`, `[MVU_` — anywhere; those belong to the installer.

---

## 3. Install, upgrade, repair, uninstall

**Install** — the plugin's library row → **Install to this card**. The dialog asks for the **state root**
(prefilled from your id; letters, digits and `_`, starting with a letter, and not `constructor` or `prototype`) and one call per phase your tokens
declared; when exactly one call fits a phase it is preselected. Then the entries, the engine and the panel
are written, the registry records every answer, and your empty drawer appears in the open chat at once.

The success message names what the user should know: the interfaces your plugin matched (`uses cast@1 →
Classmate`), the ones it runs without, what happened to the card's schema (§5.4), and where your panel is.

**Upgrade / Repair** — the plugin's card row offers **Upgrade** when the library holds a newer version, and
**Repair** when pieces are missing from the card's book. Either reinstalls from the library copy: the recorded
entries are deleted first (so an entry you renamed cannot survive under its old name) and the new ones
written. The state root and call bindings are **reused** — the user re-picks nothing, and the root cannot move
because the subtree under it is a live game. An install touches **no state**: a v2 that keeps new keys simply
starts writing them. An older library copy offers no button; installing it is Uninstall, then Install.

**Uninstall** — asks twice: remove the plugin, then whether to also delete its saved state. The default keeps
it, so a reinstall picks up where it left off. Nothing outside your root is touched. Your schema is removed
only if your install wrote it and the card still carries exactly that text.

**Drift** — if the user renames or removes the call your entries are bound to, they route to nothing. Each chat
load warns naming the missing call, the plugin's card row shows a **Drift** pill with the reason, and **Rebind
PRE call** (or **Rebind POST call**) rewrites the entry comments to another call. An interface your plugin uses
that the game stops exposing shows Drift too.

---

## 4. Entries — the three windows

An entry is a worldbook entry. `comment` and `content` get token substitution; every other field passes
through verbatim, so `order`, `position`, `depth` and the rest mean what they mean in SillyTavern.

**A call tag in the comment is what claims an entry.** That makes three windows, not two:

| Window | How you ask for it | Who reads it | Costs |
|---|---|---|---|
| **narrate** | **no call token**, `type: "constant"` | the narrator, directly | nothing — no extra LLM call |
| **PRE** | `{PRE_CALL}` in the comment | that call's model; **its output then reaches the narrator** | one call |
| **POST** | `{POST_CALL}` in the comment | that call's model, after the reply | one call |

Routing matches a `[callName]` tag anywhere in the comment (or the keys), ignoring case. An entry with no call
tag is an ordinary worldbook entry and lands in the narrate window — which is where anything you can
**compute** belongs: an LLM round trip to relay a number you already have buys nothing.

- `type` decides whether an untagged entry appears at all: `selective` with no keys never activates, so a
  narrate entry must be `constant`.
- A routed entry is sent to its call whether or not it is enabled — routing reads the comment, not the switch.
  Keep it out of the narrator's prompt: disabled, or `selective` with no keys. Validation refuses a routed
  entry SillyTavern would also inject — enabled and `constant`, or enabled with keys (rule 15).
- Whether a routed entry reaches a model is the call's switch in Extra LLM Calls. On chat load, a call that
  will not run while entries are routed to it is named in the console; a call that is on but has no
  connection profile also raises a toast.

A standalone plugin keeps to **one** window that asks the model for something — narrate or POST. A report-only
narrate entry (it shows state back and asks nothing) beside a POST recorder counts as one.

**A routed block is not guaranteed every turn.** Your POST entry shares one call — and one OUTPUT — with
everything else routed there. The model may spend its output on a competing contract, or the provider may cut
the output mid-stream (`the provider CUT this output…` in the console names that case). Design for it: a
resolver that reads `ops` (§7) records the absence instead of double-counting later, and any state you keep
must tolerate skipped turns.

### You are sharing the game's prompt — write like a guest

Every entry routed to a call is **concatenated into one system block**. Your entry sits in the same prompt as
the game's own instructions, one model reads both and writes one output, and a model does not know which
block taught it what. Your examples are the game's examples too: a plugin that shows `add` ops beside a game
that writes a tuple with `replace` can teach the game's own bookkeeper the wrong verb, and the game's op is
then refused while yours are fine.

- **Keep example ops few** — a long block of yours can dominate the call's whole answer.
- **Match the host's verbs on shapes you share.** If the game writes tuples with `replace`, do not model `add`
  beside it, even for your own keys.
- **Write only your own root**, so a borrowed path is harmless as well as a borrowed verb.
- **Avoid copy-verbatim framing** — the model cannot scope "copy this exactly" to your block only.
- **Say your verbs are yours** — one line telling the model not to carry this block's style into another's.

**Or bind to your own call.** The dialog lists *every* call configured for the phase, not just the game's.
Point your plugin at a separate call and the two prompts never meet. It costs one extra LLM request per turn,
which is why sharing is the default for a small, well-behaved entry.

Nothing detects prompt-level influence for you: the resulting write is well-formed, just wrong. The console
names refused POST paths (`[POST] N/M op path(s) ABSENT`), which is a symptom, not the cause.

### PRE reaches the narrator through its OUTPUT

A PRE entry is not read by the narrator. mvu-helper hands **every PRE call's output** to the narrator's prompt,
so a PRE entry shapes the prose only through what its model *writes*.

**Bind a PRE entry that asks for prose to a call of its own.** A game's PRE call often carries an output check
(`outputRegex`) on its prose. The check runs on the output's PROSE — patch blocks are taken out first and kept
either way — and prose that fails is dropped whole, the game's own text included. A model that obeyed your
extra line on a shared strict call takes the game's PRE text down with it. The console says
`the output FAILED the card's output-check regex — dropped as garbage` when it happens.

```jsonc
{
  "comment": "{PRE_CALL} weather pre",
  "content": "…",
  "order": 268,
  "position": "before_character_definition",
  "type": "selective",
  "enabled": true,
  "key": [], "keys": []
}
```

Installed, the comment becomes `[GameLogicPlugin:weather] [PRE] weather pre`. Both halves matter: the
`[GameLogicPlugin:weather]` prefix is how uninstall finds the entry, and `[PRE]` routes it.

### EJS runs in your entries

Routed blocks are rendered with ST-Prompt-Template's engine before they are sent, so an entry can compute:
`<%_ … _%>` for logic, `<%= … %>` to print escaped, `<%- … %>` to print raw (needed for JSON). Read state with
`getvar('stat_data')`. **Never write with `setvar`** — the render context is the live message store, so a
`setvar` during prompt assembly persists, and prompt assembly happens more than once per turn.

### Dice: your own pool

```js
const die  = (globalThis.MvuHelper.rollPool(1, null, 'RAIN') || [])[0];   // count, hash, POOL NAME → one d20
const move = globalThis.MvuHelper.rollPool(2, null, 'MOVE', 6);           // the 4th argument is the faces → 2d6
```

`MvuHelper.rollPool` is mvu-helper's dealer, present on every card it runs on, engine or not, and synchronous.
Pass **your own pool name**: pools are independent and grow by append, so your dice never take a slot from the
game's. Passing a `hash` instead deals swipe-stable dice — same `(count, hash)`, same dice. A pool is a name AND
a face count (`MOVE` in d6 and `MOVE` in d20 never share a slot). A pool holds up to 20 dice; a count that is not
a whole number from 1 to 20, or faces that are not a whole number from 2 to 1000, deal nothing (`[]`) and log
which argument was wrong. Deal every die your resolver needs in your entry: the resolver only reads them (§7).

### Logging: `MvuHelper.log`

The same logger is on `globalThis.MvuHelper` in your entries and on `MvuHelper` inside your engine. Each line
prints with who wrote it:

    [mvu-helper] [card] [weather] …              an entry's line (any card script on the page)
    [mvu-helper] [engine:plugin:weather] …       your engine's line (inside the Worker)

| call | prints |
|---|---|
| `error(…)` · `warn(…)` | always |
| `lifecycle(…)` · `verbose(…)` · `trace(…)` | when the user's verbosity reaches that level |
| `domain(name, level, …)` | when that debug domain is on: `pipeline`, `imagegen`, `roster`, `smallllm` |
| `enabled(level)` · `domainEnabled(name)` | nothing — whether such a line WOULD print |
| `child(tag)` | nothing — the same logger with one more tag: `MvuHelper.log.child('weather').warn(…)` |

On the page every card script shares the `[card]` source, so tag your entries with `child`.

### Settings: `MvuHelper.settings`

mvu-helper's settings, by name, on `globalThis.MvuHelper` in your entries and on `MvuHelper` inside your engine:

| name | value |
|---|---|
| `debug.verbosity` | `'off'`, `'lifecycle'`, `'verbose'` or `'trace'` |
| `debug.pipeline` · `debug.imagegen` · `debug.roster` · `debug.smallllm` | `true` or `false` — that debug switch |
| `language` | `'en'` or `'zh-cn'` — the panel's language |

`get(name)` answers the value; a name not in the table answers `undefined` and warns once. `names()` lists the
table. `set(name, value)` turns a debug switch on or off from an entry and returns `true`; anything else — the
verbosity, the language, a value that is not `true` or `false`, any call inside the Worker — sets nothing,
returns `false` and warns. Read settings this way rather than through `SillyTavern.extensionSettings`, which
hands your template every extension's settings to find one switch, and makes every install of your plugin ask the
user first (`security-hardening.md` §6):

    <%_ if (globalThis.MvuHelper && MvuHelper.settings && MvuHelper.settings.get('debug.pipeline') === true) { _%>

---

## 5. Writing into `stat_data`

Your plugin owns exactly one subtree: `GameLogicPlugin.<StateName>`, the root the user picked. `{OWN_ROOT}`
gives you its dotted path; a resolver also receives `ownPointer`, the same root as a JSON Pointer. Owning it
means nothing else writes there — it is not a permission boundary. Every lane below reaches as far as the card's
Zod allows; whether you *should* write a game path is the game's call (§8.2).

### 5.1 The four write lanes

| Lane | The ask | Gate |
|---|---|---|
| **prose request** (narrate / PRE output) | the narrator must *interpret* a request and act on it in the story | the game's own rules, then Zod |
| **PRE `<JSONPatch>`** | the PRE model *copies a printed block* | Zod |
| **POST `<UpdateVariable>`** | the POST model *copies a printed block* | Zod |
| **`resolveRelay`** (§7) | nothing — your code runs | Zod |

**The patch lanes are not best-effort.** Once a block is in the output, delivery is host code: mvu-helper takes
every block out, salvages it per op, applies it through `Mvu.parseMessage` — the call the game's own systems use
— and saves the result. So the question is only whether the model emits the block, and copying a printed block
is a mechanical ask. The prose lane is the soft one: it asks a narrator to understand you.

**The relay lane** involves no model at all: it cannot be declined, reworded or crowded out, and it reads what
the turn *actually did*. Its ops go through the same `Mvu.parseMessage`, reach the same paths and are refused by
the same Zod. Put anything that must be exact there; use the patch lanes when a model's judgement is the input;
use the prose lane only for what must read as story.

### 5.2 Your drawer

The host creates your drawer — `GameLogicPlugin.<StateName>`, empty — at install, on every chat load, and on the
two messages a new generation can seed from. You create whatever you keep inside it, whenever you start keeping
it. **The drawer is your registration**: an op into a missing drawer still lands and creates the containers on its
way, which rebuilds a root the host never registered. So write only when your drawer is there, and report it
when it is missing.

### 5.3 You declare no state shape

There is no `init` in a plugin file. The `schema` you ship declares `GameLogicPlugin` **open**, which is the
opposite of describing a shape: it is what lets you create keys nobody predicted.

### 5.4 The schema you ship, and the one the card has

Something has to declare `GameLogicPlugin` open in the card's Zod schema, or every key you create is stripped or
refused. Your `schema/` file is two lines of substance, the platform roots:

```js
// the platform roots, open — yours declares these and nothing else
GameLogicPlugin: z.record(z.string(), z.any()).prefault({}),
$mvuhelper: z.record(z.string(), z.any()).prefault({}),
```

`$mvuhelper` is mvu-helper's own root (what each character wears, the character registry); declaring it keeps a
card whose only schema is yours from losing it. The blank Plugin from the Development tab ships both.

Declare **the root itself** open too, so every other root passes through untouched: `z.looseObject({...})`, or a
`z.object({...})` reopened with `.passthrough()` or `.catchall(z.any())`. A plugin schema that closes its root is
refused: it names only the platform roots, so under a closed root every write into the game's roots is dropped. Do not name a
game's roots in it — that is what breaks the next card you install on. Do not rely on `mvu_zod` to reopen a
closed root: it re-wraps a registered root as `looseObject` only while the root is `instanceof z.ZodObject`, and
`.prefault({})` makes it a `ZodPrefault`.

The file may only declare: anything off the schema allow-list is removed before it installs, and the rest
installs (`gamelogic-pack-format.md` §6 lists what stays).

Install decides, per card, whether your schema is written:

| The card has | Install | The success message says |
|---|---|---|
| no schema at all | writes yours — without it MVU's derived schema freezes your empty drawer | `added its schema (the card had none)` |
| a schema its GameLogic Pack installed | skips yours — rule 7 already made the game keep the platform roots, and replacing it would drop every path the game declares | nothing |
| exactly your schema | skips | nothing |
| the schema your plugin wrote earlier | replaces it with this version | `updated its own schema` |
| a schema from anywhere else (the card itself, another plugin) | **asks**: Yes replaces it with yours (the card's own rules go), No keeps the card's and installs without yours. The answer is recorded, so an upgrade or the dev loop does not ask again | `replaced the card's schema` / `kept the card's schema` |

Nothing is written to the card until that question is answered.

A card can lose its schema under you: uninstalling a GameLogic Pack removes the schema it owned, and your copy was
skipped at install because the pack's was there. From then on MVU's derived schema refuses every new key under
your drawer. Your plugin's row then says the card has no schema and offers **Repair**, which runs the decision
again, finds a card with no schema, and writes yours.

### 5.5 What MVU will and will not let you write

**Which apply lane runs depends on the card.** A card whose Zod `Scheme` script is running (`mvu_zod`) applies
each op on a copy and validates the whole object: containers are created for you and depth is free. A card with
**no** Zod script — a legitimate kind; standalone plugins exist for it — applies through MVU's native
`json_patch`, which refuses a deep `add` through a missing parent: `Cannot assign into path '…' because it holds a
primitive value (undefined). The operation was skipped. (json_patch)`.

**Write portable shapes — ops that land the same on both kinds:**

- **Create every parent yourself, in the same patch.** Ops apply in order within one parse, so a guard op makes
  every later op's parent real:
  ```jsonc
  {"op":"add", "path":"<own>/Characters",       "value": {}}                       // ONLY when previous state lacks it
  {"op":"add", "path":"<own>/Characters/Mira",  "value": {"Outfit":"…","At":"2:0"}} // ONE object-valued op per child
  ```
  Make the guard conditional on your previous state — `add` is a set, so an unconditional `{}` wipes the container.
- **One object-valued op per child**, not one op per leaf.
- **`replace` on any tuple index; `add` only for keys you create in your own drawer.**

| Op | Zod card (`mvu_zod` running) | plain card (MVU native) |
|---|---|---|
| deep `add`, parents missing | applies — parents created | **refused**, warns by name |
| `add` at a `[value,"Label"]` tuple index | inserts → arity fails → **op reverted, silently** | **splices** — the tuple is now 3 long and stays so |
| `add` a NEW key on a closed or frozen root | refused by the schema | varies — do not design on it |
| scalar `set` over a `[v,"Label"]` field | judged by the declared shape | **coerced** into slot 0 |
| string where a number was | judged by the declared shape | **coerced** through `Number()` |

**The tuple trap.** MVU stores many fields as `[value, "Label"]`. JSON Patch `add` at an index **inserts**; `replace`
at the same path with the same value applies on both kinds. `/-` appends to a labeled tuple too, so use `/-` only
on lists you own.

```jsonc
{"op":"add",     "path":"/World/Weather/0", "value":"Storm"}   // Zod: reverted · plain: ["Storm","Clear","Weather"] persists
{"op":"replace", "path":"/World/Weather/0", "value":"Storm"}   // applies on both — ["Storm","Weather"]
```

One refused op does not void the others in its block, so an op you expect may fail is safe beside real writes.
Before you design around any constraint here, run the op against a copy on the card kind you target:
`Mvu.parseMessage(block, structuredClone(vars))` answers in one call and never touches a save.

**When your writes vanish, the error text says which lane judged them:**

| Refusal text | Who refused | Meaning |
|---|---|---|
| `✖ Too big` / `路径:` … | mvu_zod (Zod) | your op broke a declared shape |
| `Cannot assign into path '…' because it holds a primitive value (undefined) … (json_patch)` | MVU native | your op assumed a parent — create it yourself; the card is fine |
| `SCHEMA VIOLATION: Cannot assign the new key … non-extensible object` `(json_patch)` | MVU native | a frozen derived root. On a card that SHOULD have Zod, its `Scheme` script is not running — fix that, not your plugin |

### 5.6 Pre-compute the patch in EJS

Every value the model has to construct is a value it can get wrong, and the POST call has no guaranteed view of
your subtree. Hand it a finished op and leave it nothing to do but decide whether to emit it:

```
<%_
const ROOT = '{OWN_ROOT}';                        // "GameLogicPlugin.Weather"
const PATH = '/' + ROOT.split('.').join('/');     // "/GameLogicPlugin/Weather" — JSON Patch wants slashes
const sd = (typeof getvar === 'function' ? getvar('stat_data') : null) || {};
let mine = sd; for (const seg of ROOT.split('.')) { mine = (mine && typeof mine === 'object') ? mine[seg] : undefined; }
mine = mine || {};
const log  = Array.isArray(mine.Log) ? mine.Log.slice() : [];
const turn = Number(mine.Turn) || 0;
_%>
# Emit BOTH ops, copied EXACTLY; do not recompute the numbers:
#   { "op": "add", "path": "<%= PATH %>/Log",  "value": <%- JSON.stringify(log.concat([line])) %> }
#   { "op": "add", "path": "<%= PATH %>/Turn", "value": <%= turn + 1 %> }
```

Deriving the slash path from the dotted one means whatever root the user chose is what the instructions name.

### 5.7 Make it idempotent yourself

A turn can produce more than one POST pass, and nothing upstream de-duplicates your entry's ops. Guard on a
per-generation value: `rollPool` deals once per generation and a pool's prefix never changes inside one, so a
second pass renders the same seed — and a seed equal to the one already recorded can render a "record nothing"
branch. If your guard keys on something that can be absent, say so for that turn rather than silently keying on
something else.

### 5.8 Strict games

A game's own POST contract may forbid ops outside its paths, and a well-behaved POST model then ignores yours.
Three ways out: bind your POST entry to a call of its own, ask the game's author to allow plugin-owned paths, or
use the relay lane (§7), which involves no model.

---

## 6. Checklist

- `packType: "plugin"`, a kebab-case `id`, a `description` someone can decide from, a numeric `version`.
- Every phase you need declared **by using its token**, nowhere else.
- Every routed entry kept out of the narrator's prompt: disabled, or `selective` with no keys (rule 15).
- Anything you can **compute** in an untagged `constant` entry — the narrate window, no call, no cost.
- A `{PRE_CALL}` entry that asks for prose bound to a call of its own (§4).
- **No `init`**; a **`schema/` file** declaring the platform roots open and nothing else (§5.4).
- **Portable write shapes**: every parent created in the same patch, guarded on previous state; one
  object-valued op per child; **`replace`, never `add`, on a tuple index**.
- Write only inside your drawer, and emit nothing on a turn where it is missing.
- Your own named `MvuHelper.rollPool` pool, dealt in an entry; an idempotence guard on anything that counts.
- Reaching into the game's state goes through `exposes` (§8.2), never through nouns learned from its card.
  Never `setvar` during a render.
- Validate before installing, and fix the warnings — an unsubstituted token reaches the prompt.
- Shipping an `engine`? §7 is its contract, and §8.5 the checklist for a game you have never seen.
- Going standalone? One window (§4), capabilities discovered not assumed (§8), portable write shapes (§5.5),
  and a panel that still says something on a card with no game (§9).

---

## 7. The plugin engine — `resolveRelay`

The relay lane takes the model out of bookkeeping: a resolver cannot be declined, reworded or crowded out, and it
reads what the turn *actually did*. Ship an `engine` section — one self-contained JS text, or several files joined
in `engineOrder` — and install hosts it on the card (a silent `[GameLogicPlugin:<id>:Engine]` entry, so it keeps
working after the library file is deleted) and loads it into the **same Worker as the game engine, in its own
scope**.

```js
const ENGINE_VERSION = 'v1.0.0';     // a string literal, exported; reported and logged, never compared

module.exports = {
  ENGINE_VERSION,
  resolveRelay({ ownState, snapshot, ops, dice, dicePools, exposes, engine, roster, ownRoot, ownPointer, pluginVersion, mid, swipe }) {
    return {
      patches: [                                                    // ABSOLUTE JSON Pointers
        { op: 'replace', path: ownPointer + '/Turn', value: (ownState.Turn || 0) + 1 },
      ],
      log: ['turn recorded'],                                       // the host prints these
    };
  },
};
```

### 7.1 When it runs

`resolveRelay` runs **once per reply, after the reply's last write**, in the same reply, on every card:

- **POST wrote a block:** when that block is applied — after the game engine's own `resolvePostRelay` on a card
  whose engine exports one, otherwise alone. Your writes are saved with POST's.
- **POST wrote nothing, or no POST call ran** (none configured, Extra LLM Calls off, a call that failed): once
  the reply's own parse is done — RES1 included on a card with a game engine — and the post-reply phase has
  finished. A quiet reply is still your reply: record the absence rather than skipping it.

The host keeps the once-per-reply guard, not you; a regenerate is a new reply. A reply the user stops
mid-stream is not recorded, and your resolver does not run for it. When the next generation starts before your
writes are saved, the turn fence drops them rather than write them into another reply.

### 7.2 What it receives

- **`ownState`** — your drawer (a copy; mutating it changes nothing — return patches). **`snapshot`** — all of
  `stat_data` but MVU's own `$internal`, also a copy, for reading the game and other plugins.
- **`ops`** — the turn's APPLIED variable operations, `[{ path, old, new, by }]` with dotted paths, collected by
  diffing the state before and after each parse. Refused ops never appear; several writes to one path inside
  one parse collapse into one; arrays report whole. **`by`** names the lane: `'message'` (the reply's own
  `<UpdateVariable>`), `'pre-sim'` (a PRE call's patch), `'post'` (POST's block), `'plugin:<id>'` (a plugin's
  relay — your earlier writes read back with your id), `'statusmenu:<id>'` (a status-menu action), `'host'` (any
  other mvu-helper lane). This is what a resolver can do that no prompt can: *"did the narrator actually move the
  population"* is answered by an op, with zero model calls.
- **`dice`** — every die dealt this generation, flat; **`dicePools`** — the same per pool, `{ pool, sides, dice }`
  or `{ hash, sides, dice }`. Check a claimed die against the pool it came from (in the flat list a d6 "4" passes
  on a d20's 4). Both are `null` when nothing was dealt: verify nothing — it is not permission to roll.
- **`exposes`** — your declared interfaces resolved to this game's paths, `{ "cast@1": "Classmate" }`, `{}` when
  nothing matched (§8.2).
- **`engine`** — the game engine's identity, `{ name, type, version, packId }`, every field `null` when unknown
  (§8.1).
- **`roster`** — every installed plugin's id → its root, because user-picked names defeat guessing.
- **`ownRoot`** / **`ownPointer`** — your root as a dotted path and as a JSON Pointer. **`pluginVersion`**,
  **`mid`**, **`swipe`**.

### 7.3 What it returns

**`patches`** are ordinary JSON Patch ops — `add` / `replace` / `remove` with ABSOLUTE JSON Pointer paths. Build
them off `ownPointer` for your drawer, or name any path the card's Zod allows. The host shape-checks each op and
hands them to `Mvu.parseMessage` in one `<UpdateVariable>` block — so **Zod judges your ops like anyone else's**:

- a malformed op (or one whose value is not JSON) is dropped ALONE, by index; its siblings still go;
- an op can be **refused**, and the receipt says so: the console line reads
  `[RES2] plugin <mid:swipe>: "<id>" landed N/M op(s) (K refused)`, and a warning lists every op that did not take,
  with what was sent and what is stored (`landed · coerced · changed · refused · absent`). Do not assume a write
  landed.

**`log`** — lines the host prints as `[mvu-helper] [gamelogic-plugin] "<id>": …` (pipeline domain). For your own
lines while it runs, use `MvuHelper.log` inside the Worker.

A resolver that throws is logged by name, its patches are dropped, and the turn continues — the other plugins and
the game included. A broken engine TEXT is the same: its scope reports the error at load and every other text still
boots.

### 7.4 Where it runs

The Worker runs inside a hidden frame: no DOM, no network, no dynamic `import()`. Your text sees the JavaScript
language plus `console`, `crypto`, `structuredClone`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, and
`MvuHelper` — `engineInfo()` (§8.1), `log` and `settings` (§4) and `messages` (the chat's messages as index, role
and swipe, no text). Each text runs in its own scope with its own private root: `window.X` from one text is invisible to every
other, and plugin code cannot call the game engine's exports. Coupling happens through data (the snapshot) and
prompts. Every call crosses the Worker boundary, so arguments and results are copies. `devdoc/security-hardening.md`
has the whole boundary.

Your engine text is stored as `[GameLogicPlugin:<id>:Engine]`, inside the installer's own prefix; an entry of your
own may say "Engine" freely.

### 7.5 `renderPanel`

A plugin engine may also export `renderPanel(ctx)` to compute its side-panel slot instead of binding it. Its ctx
is the relay's read side without the turn fields — `{ ownState, snapshot, engine, exposes }`, with the same
`engine` and `exposes` as `resolveRelay`. The format is in `devdoc/side-panel-format.md`.

---

## 8. Running on a game you have never seen

Your plugin gets installed on a card you did not write. Two questions decide whether it does anything useful there,
and these are the sanctioned ways to ask them:

1. **Which game is this?** → engine identity (§8.1)
2. **Where does this game keep the thing I need?** → `exposes` (§8.2)

**Never guess.** "Scan `stat_data` for objects with a `Name` key" looks generic and is a fallback in disguise: items
have names too, a genre that calls the field `CharName` reads as zero cast — no error, just nothing — and every
plugin ends up carrying its own drifting adapter. Identity gives you a sharp arm on games you know; `exposes` gives
you a working arm on games you don't.

### 8.1 Identity — branch on NAME, never on shape

A game engine declares its identity in its own exports: `ENGINE_NAME`, `ENGINE_TYPE` (its family — RPG, Love,
School…) and `ENGINE_VERSION`, all string literals. mvu-helper reads them; nothing is parsed out of the text.

| You are writing… | You ask… |
|---|---|
| resolver or renderPanel code (the Worker) | `ctx.engine` → `{ name, type, version, packId }` |
| EJS inside an entry | `globalThis.MvuHelper.engineInfo()` → the same fields plus `exposes` (the active pack's whole map) |
| plain text inside an entry | `{{mvuhelperEngineName}}` · `{{mvuhelperEngineVersion}}` |

- **Match on `name`.** `type` tells you the family, but two games of one family can keep their state differently —
  which is why `exposes` exists.
- **Version is information, not a gate.** Gate on it only to work around a specific known change, and say so.
- **`null` means unknown** — a card with no game engine, or an engine that declares nothing. Treat it as "unknown
  game": fall back to prose, or render nothing. **Never emit a guessed channel or path** — a hallucinated `/Intent/`
  emit does not fail loudly, it is simply ignored.

**The ordering trap.** EJS renders FIRST; macros expand AFTER. EJS can *output* a macro and can never *read* one:

```ejs
<%_ if ('{{mvuhelperEngineName}}' === 'School') { _%>   ← ALWAYS FALSE — EJS sees the literal token
```
```ejs
<%_ const engine = (globalThis.MvuHelper && globalThis.MvuHelper.engineInfo()) || {}; _%>
<%_ if (engine.name === 'School') { _%>                 ← correct — branching code uses the global
```

### 8.2 `exposes` — ask for an interface, receive a path

The game declares where things live; you declare what you need; the host matches the two. In the game's `pack.json`:

```json
"exposes": { "cast@1": "Classmate" }
```

In your plugin:

```json
"requires":     ["cast@1"],
"optionalUses": ["clock@1"]
```

An interface name is `<name>@<major>` — lowercase, `/^[a-z][a-z0-9-]*@\d+$/`, checked when your file is imported (a
malformed name can never match, and the install message would blame the game for your typo).

- **`requires`** — your plugin is meaningless without it. Unmatched ⇒ **install is refused**, naming the interface.
- **`optionalUses`** — you can still do something useful. Unmatched ⇒ installs and says it runs without it — **and
  you owe the user that path.** Declaring optional and then throwing on `undefined` fails at turn time instead of
  install time.

The host is a **blind string broker**: it hardcodes no interface vocabulary, compares strings and hands back paths.
It never checks the shape for you — if the game exposed the wrong path, you read `undefined` off the snapshot.

- **In a resolver or renderPanel:** `ctx.exposes` — *your* declarations resolved, and nothing else.
- **In EJS:** `globalThis.MvuHelper.exposes()` — the **active pack's whole map**. Read only what you declared
  anyway: an undeclared interface gets no install-time refusal and no drift warning when it disappears.

If an exposed path stops existing in live `stat_data`, chat load warns and your plugin's card row shows Drift.
Your resolver still runs and must cope with the absent node.

### 8.3 Worked example — a cast journal that runs anywhere

```js
module.exports = {
  resolveRelay({ snapshot, exposes, engine, ownPointer }) {
    const log = [];

    // WHERE is the cast? Ask by interface — there is no game noun in this file.
    const castPath = exposes['cast@1'];
    if (!castPath) {
      // The path you owe the user for declaring optionalUses.
      log.push('cast@1 not exposed by this game — recording nothing but the mode');
      return { patches: [{ op: 'replace', path: ownPointer + '/Mode', value: 'degraded' }], log };
    }

    // The game named the path; you walk it.
    const cast = castPath.split('.')
      .reduce((node, seg) => (node && typeof node === 'object') ? node[seg] : undefined, snapshot);
    if (!cast || typeof cast !== 'object') {
      // Declared but absent is a real state: a fresh card, or a root the game creates lazily.
      // Handle it; never throw — a throw drops all your patches.
      log.push('cast@1 -> ' + castPath + ' absent from stat_data this turn');
      return { patches: [{ op: 'replace', path: ownPointer + '/Mode', value: 'awaiting-cast' }], log };
    }

    const ids = Object.keys(cast);
    // MVU stores many fields as a 2-slot [value, "label"] tuple: UNWRAP before use.
    const unwrap = (v) => (Array.isArray(v) ? v[0] : v);
    const firstName = ids.length ? unwrap(cast[ids[0]].Name) : '';

    const patches = [
      { op: 'replace', path: ownPointer + '/Mode',      value: 'live' },
      { op: 'replace', path: ownPointer + '/CastCount', value: ids.length },
      { op: 'replace', path: ownPointer + '/FirstName', value: firstName },
    ];

    // WHICH game is this? A game-specific arm only behind a NAME the engine declared itself.
    if (engine.name === 'School') {
      patches.push({ op: 'replace', path: ownPointer + '/Note',
                     value: 'School cast journal (engine ' + (engine.version || '?') + ')' });
    } else {
      log.push('engine "' + (engine.name || 'unnamed') + '" — generic journal, no game-specific writes');
    }

    return { patches, log };
  },
};
```

Both questions asked, no game noun outside the named branch, and every "not available" state answered with a
written path instead of an exception.

### 8.4 The same two questions from an entry

```ejs
<%_
const helper   = globalThis.MvuHelper || {};
const engine   = (helper.engineInfo && helper.engineInfo()) || {};
const exposes  = (helper.exposes    && helper.exposes())    || {};
const castPath = exposes['cast@1'];
_%>
<%_ if (engine.name === 'School' && castPath) { _%>
The cast register is at <%= castPath %>. Follow this game's own write rules when you change it.
<%_ } else if (castPath) { _%>
Cast records live at <%= castPath %>. Describe any change in prose and let the game record it.
<%_ } _%>
```

On a game with no cast interface the entry renders empty and costs zero tokens — you have nothing true to say.

### 8.5 Checklist

- [ ] Every game noun in your resolver came out of `exposes` or sits behind an `engine.name === '…'` branch.
- [ ] `engine.name === null` is handled as "unknown game", not as an error.
- [ ] Every `optionalUses` interface has a written path that returns rather than throws.
- [ ] Declared-but-absent is handled separately from not-declared.
- [ ] Tuples unwrapped on every field read out of the game's state.
- [ ] No macro read inside `<% %>`; branching uses `globalThis.MvuHelper`.
- [ ] Version recorded, not gated (unless you name a specific change).

### 8.6 The interface registry — what a game may publish

**This table is the API.** mvu-helper hardcodes none of these names; it compares strings and hands back paths, so
this is the only place the vocabulary is written down. A name is a promise about **shape**, never about location: a
game may move its root tomorrow by changing one line of its pack, and every plugin keeps working. Changing the
*shape* breaks every consumer silently — that needs `@2`, published beside `@1` until consumers move.

| name | shape a publisher promises | what a plugin does with it |
|---|---|---|
| **`cast@1`** | map of id → object with at least `Name` | the recurring people — classmates, party, partners, familiars |
| **`player@1`** | object with at least `Name` | who the story is about; addressing the protagonist correctly |
| **`location@1`** | the id of the place the scene is in now | "where are we": scene-bound features, travel |
| **`landmarks@1`** | map of id → object with at least `Label`; an id is the same string `location@1` holds while the scene is there | the places the game has named: a map of them, a travel menu |
| **`chronicle@1`** | map of id → object with at least `summary` | recaps and memory |
| **`clock@1`** | object with at least `Date` (ISO `yyyy-mm-dd`) and `Time` (`HH:MM`) | anything scheduled: cooldowns, deadlines, "next week" — days between two dates is date arithmetic |
| `locale@1` | string language tag | the plugin localises **its own** output |

- **`landmarks@1` is not every place in the world.** A game may record only the places found during play, so
  `location@1` can name a place `landmarks@1` lacks. Read a missing landmark as "no label", never as "nowhere".
- **A value may arrive as MVU's `[value, description]` pair.** School writes every leaf that way: `Name` is
  `["Mitsuki Tachibana", "Name"]`, and `location@1` resolves to `["Town_BusStop", "Location"]`. Read
  `Array.isArray(v) ? v[0] : v` wherever a shape names a value.

`cast@1`, `player@1`, `location@1`, `landmarks@1`, `chronicle@1` and `clock@1` are published today — School v4
exposes them as `Classmate`, `Mainchar`, `World.Location`, `WorldRecord.Locations`, `WorldRecord.Events` and
`World`. `locale@1` is **proposed**: nothing publishes it yet, so its shape is the minimum a first publisher should
commit to. A plugin that `requires` an unpublished name is refused at install; one that `optionalUses` it installs
and runs without it.

`player@1` promises a `Name` and nothing more, even where a game's player root carries money, stats and inventory:
the next game to publish `player@1` may have none of it. A plugin that wants a game's extras branches on
`engine.name` and owns that coupling.

**What a game must NOT expose**

- **Its write-channel namespace** (School's `Intent`). Publishing it hands out a write API by accident; channel
  emits belong behind an `engine.name` branch.
- **Mid-turn handoff slots** (School's `PendingState`). One actor sets, another consumes and clears; read out of
  turn context the value is meaningless.
- **Anything that already has its own contract** (Event Pack paths, which the engine's exports state). Two
  mechanisms carrying one fact drift apart.

**Rules for adding a name**

1. **Name the concept, not your noun.** `cast@1`, never `classmate@1`.
2. **Promise the minimum.** Every field you add to a shape is a field the next publisher must also produce.
3. **Publish a place you can keep publishing.** The path may move; the interface may not disappear.
4. **Do not publish what cannot be used blind.** If a plugin needs your design docs to interpret the node, it
   needs a name branch, not an interface.

**`exposes` grants no permission.** It answers *where is it*, never *may I write here*:

- **Containment is solved a layer down** — engine text runs in the Worker under a deny-by-default capability block
  and a policy that refuses every network load (§7.4).
- **Zod is the real fence.** Every op a plugin emits is judged by the card's own schema exactly like the game's. A
  game that wants a registry closed **closes it in its schema**.
- **Which plugins to trust is the user's call.**

For a game author that is one sentence: **do not publish a path you would be upset to see written.**

---

## 9. The card with no game

A plugin with no `requires` can land on a card with no GameLogic Pack. Nothing here is a mode you switch on: the same
folder installs on both columns unchanged, and when a pack arrives later the next load simply finds more.

| What you reach for | Card WITH a GameLogic Pack | Card with NONE |
| --- | --- | --- |
| `ctx.engine` | the pack's engine identity | all fields **`null`** — your generic arm runs (§8.1) |
| `ctx.exposes` | your declarations resolved, `{"cast@1": "Classmate"}` | **`{}`** — every `optionalUses` runs without |
| `requires` | matched at install | **refused** — which is why a standalone plugin declares none |
| `globalThis.LogicEngine` | present | **absent**; the shared Worker still hosts YOUR scope |
| prompt windows | narrate, PRE, POST | all three — Extra LLM Calls are the user's, not the pack's |
| `MvuHelper.rollPool` in an entry | the dealer | the same dealer |
| `resolveRelay` runs | once per reply: after POST's block and the game's relay, or after the reply when POST writes nothing | once per reply: after POST's block, or after the reply when POST writes nothing |
| your write gate | the game's Zod — your `schema` is skipped | **your own `schema`**, written at install |
| a panel slot | yes | yes |

**A resolver never rolls.** The deal happens in your entry at prompt time; the resolver verifies a die the prose
reports against `ctx.dice`. A die minted after the model is done is a die the model never saw. (`crypto` is there in
the Worker for randomness no prose ever reports.)

**Your panel binds YOUR drawer.** An interface path is the portable way to read a pack, and on a card with none it
renders the missing marker — honest, and useless as the only thing in your slot. Bind your own drawer for everything
that must show on any card.

**One window.** A plugin authored for this column keeps to one model window — narrate (free, rides the main model) or
POST (a cheap model that records what the prose did): its cost lands on users who never chose your genre.

- [ ] `engine.name === null` and `exposes` `{}` both have a written arm that RETURNS, not throws.
- [ ] No `requires` — or you meant to write a game-bound plugin.
- [ ] Entry dice come from `MvuHelper.rollPool` under your own pool name; the resolver only verifies.
- [ ] Every op uses the portable shapes (§5.5), and the result is RECORDED in your own state.
- [ ] The panel still says something useful when nothing is exposed.

---

## 10. The side panel slot

The format is `devdoc/side-panel-format.md` — every key, both block types, the path forms, colours and their conditions,
the caps, and `renderPanel`. A GameLogic Pack declares a panel the same way. What differs for a plugin:

- **A plugin with a `panel` gets one slot** in mvu-helper's side panel — the drawer behind the chevron at the chat's
  right edge — beside the active GameLogic Pack's slot and every other plugin's. No `panel`, no slot.
- **In the folder it is `panel/panel.json`**; in the single file, the `"panel"` object. Install stores it as a silent
  `[GameLogicPlugin:<id>:Panel]` entry; uninstall removes it; the dev loop re-applies it on every save.
- **A bare path reads from YOUR DRAWER**, `GameLogicPlugin.<StateName>`, so it works whatever root the user picked. A
  pack's bare path reads from the `stat_data` root — the only per-type difference in the format.
- **Outside your drawer**, `{cast@1}.…` reads through an interface you declared, and `$.World.Time` is a raw absolute
  read for when you know the card's shape and say so.
- **`renderPanel` lives in your engine**, exported beside `resolveRelay` (§7.5).
