# Security hardening — what a pack's code can reach

Audience: anyone who ships, installs or reviews a **GameLogic Pack**, **GameLogic Plugin**, **StatusMenu
Pack** or **Event Pack**, and anyone changing the code that runs them. This is the host's account of the
boundary: where each kind of content runs, what mvu-helper stops it from reaching, how that is proven, and
what is still open. The file formats live in each type's own doc (`gamelogic-plugin-guide.md`,
`statusmenu-pack-format.md`, `event-pack-format.md`).

**The goal** (the project owner's words): do not restrict how a pack is built, and make sure no developer
can run hostile JavaScript from inside one. mvu-helper cannot tell a hostile pack from an honest one by
reading it — a scan that hunts for dangerous names is defeated by building a name out of pieces at
runtime — so the boundaries below for code assume the code IS hostile, let it run, and limit what it can
reach. The schema is the one piece that only declares, so it is cut down to a grammar too small to call
anything before it installs (§5).

---

## 1. Where each kind of content runs

| Content | Shipped by | Runs in | Boundary |
| --- | --- | --- | --- |
| Logic engine text (`engine` → `[MVU_LogicEngine]`) | GameLogic Pack, or the card itself | the engine Worker | Worker + capability block + engine frame policy — §2 |
| Plugin engine text (`engine`) | GameLogic Plugin | the same Worker, in its own scope | the same — §2 |
| StatusMenu Engine (`engine` → `[MVU_StatusMenuEngine]`) | StatusMenu Pack | the same Worker, in its own scope; a throwaway check Worker when a pack is picked or exported | the same — §2 |
| EventPack runtime (`eventpack.cjs`) | joined into the game's engine text | the same Worker | the same — §2 |
| Event definitions (`events`) | Event Pack | data in `stat_data.EventPack`, read by the runtime | no code path exists — §4 |
| Menu documents (fenced regex rows) | StatusMenu Pack | the contained StatusMenu frame | sandbox + policy + bridge — §3 |
| Side panel (`panel`) | GameLogic Pack, GameLogic Plugin | mvu-helper's own DOM | no author markup — §5 |
| `regex` rows | GameLogic Pack | TavernHelper's message render | a row that would render a document refuses the install — §5; a row carrying `<%` installs, and the install warning reads its code first — §6 |
| Lorebook entries carrying EJS | GameLogic Pack, Plugin, StatusMenu Pack, the card | ST-Prompt-Template's template sandbox | **partial**: Environmental isolation, and the install warning naming what a pack's code reaches before it installs — §6 |
| `schema` | GameLogic Pack, GameLogic Plugin | a TavernHelper character script | only what the schema allow-list keeps is installed — §5 |

---

## 2. The engine Worker — logic engines, plugins, the StatusMenu Engine, EventPack

Every engine text on a card runs in ONE dedicated Worker, each in its own scope (the game's, one per
plugin, the StatusMenu Engine's), so their state and their errors stay apart. Four layers hold it, each
closing what the one before it cannot:

1. **A dedicated Worker** (`engine-worker-host.js`). It has no `document`, no frames, no `window.parent`
   and no way to make a new realm. On the page none of that could be closed: `document` and the
   `window[0]…window[N]` frame slots cannot be redefined by any script, and each frame is a fresh realm
   with its own working `fetch`.
2. **The capability block** (`engine-capability-block.js`), raised before any engine text runs and never
   lowered. It is default-deny: every global outside an allow-list (below) becomes a throwing stub, both
   on the global and in place on the prototype that owns it, so walking `Object.getPrototypeOf(self)`
   finds the stub too. Each blocked reach is reported once per name (`[mvu-helper] [logic-engine]
   BLOCKED — the engine text reached for …`). The raise locks the block's reporter, so engine code cannot
   replace it to silence those lines.
3. **The engine frame policy** (`engine-frame-core.js`). Dynamic `import()` is syntax, not a global, so no
   block can take it away. The Worker is therefore started by a hidden frame whose `<meta>`
   Content-Security-Policy it inherits:

   ```
   default-src 'none'; script-src 'unsafe-eval'; worker-src blob: <the Worker's four module files>
   ```

   `'unsafe-eval'` is there because every engine text becomes code through `new Function`. `script-src`
   lists no URL, so every `import()` that needs a request is refused before the request is made. The four
   files are the Worker's own startup imports, which the browser counts as Worker loads. A refused load is
   logged: `the engine frame's Content-Security-Policy refused …`. `import()` can still return those four
   already-loaded modules, with no request; none of them lowers the block, and their one lever over it —
   the reporter — is locked.
4. **The host is handed facts, not objects.** Each call carries a snapshot: a per-message list with no
   message text and no author names, the log settings, and the engine's own identity. The engine never
   receives `SillyTavern.getContext()`, the real extension settings, or any function that reaches back to
   the page, and the Worker answers only the calls mvu-helper makes.

**What engine code may use** — the whole allow-list, so an author never has to read code to learn it:

- **The JavaScript language:** `globalThis` `undefined` `NaN` `Infinity` `Object` `Function` `Boolean`
  `Symbol` `Error` `AggregateError` `EvalError` `RangeError` `ReferenceError` `SyntaxError` `TypeError`
  `URIError` `Number` `BigInt` `Math` `Date` `String` `RegExp` `Array` `Map` `Set` `WeakMap` `WeakSet`
  `ArrayBuffer` `SharedArrayBuffer` `DataView` `Atomics` `JSON` `WeakRef` `FinalizationRegistry`
  `Promise` `Reflect` `Proxy` `Intl` `Int8Array` `Uint8Array` `Uint8ClampedArray` `Int16Array`
  `Uint16Array` `Int32Array` `Uint32Array` `Float32Array` `Float64Array` `BigInt64Array`
  `BigUint64Array` `eval` `isFinite` `isNaN` `parseFloat` `parseInt` `decodeURI` `decodeURIComponent`
  `encodeURI` `encodeURIComponent` `escape` `unescape`
- **Two host capabilities a real engine was measured using:** `console` `crypto`
- **Five pure helpers, allowed before any engine asked:** `structuredClone` `TextEncoder` `TextDecoder`
  `atob` `btoa`

Anything else throws `` `<name>` is blocked for uploaded engine code `` and logs one BLOCKED line per
name. A genre that needs another name asks for it: a pure helper is added to the list, an ambient read
(time, locale, screen) is handed IN by mvu-helper instead, and any I/O is refused — the rule is written
out beside the list in `engine-capability-block.js`. `tests/engine-capability-block.test.js` fails if
this list and the code ever disagree.

**An engine checked before install runs behind the same layers.** The pack gates check a StatusMenu
layout's formatters and actions against the engine beside it, and the only way to learn what an engine
exports is to run it. When a source folder or ZIP is picked on the GameLogic Packs or StatusMenu Packs
tab, or a StatusMenu Pack is exported from a card, that engine runs in a throwaway Worker the engine frame
makes for the check alone: the same frame policy and block, loaded once, read, terminated — never the
Worker a turn is using.
An engine that never returns from load is reported after 10 s instead of freezing the page. The gate code
itself runs no engine text, and the page holds no other way to read one. (`npm run dev` reads in its own
Node process: that is the developer's workspace on their own machine.)

**What an engine can do — its job:**

- **Write `stat_data`.** `resolveTurn` returns a new state; StatusMenu actions and plugin relays return
  patches. mvu-helper applies them through MVU, and **the card's Zod schema judges every operation** — it is
  the write fence. A write the schema allows is a write an engine may make, anywhere in the state, except
  through a prototype key (`__proto__`, `constructor`, `prototype`). Those are no state keys: MVU reads a
  patch's parent with lodash `_.get`, which answers `Object.prototype` for one, then assigns into it, so the
  write would land on every object in the page. mvu-helper refuses such a path before MVU or its own walkers
  see it: in the op check every patch lane passes (PRE and POST output, `preAssemblyPatch`, plugin relays),
  in StatusMenu patches, in the paths an engine declares (`triggerRoot`, `armedPath`, `writes`, `rewards`),
  in a pack's `force` map and seed, and in a plugin's state name. The rule is `isPrototypeKey`
  (`shared/object-path.js`); the Worker keeps its own copy in `logic-engine-core.js`.
- **Write into the prompt.** `initiativeMenu`, `sweepCandidateLines`, event bodies and similar return text
  the model reads. That text can try to steer the model (prompt injection); nothing in the host can tell
  steering from story.
- **Write into the reply.** `textReplacements`, `resBlock`, `leadText` and `endText` go into the reply's text,
  except a swap or a block that would add a page-code token: TavernHelper's render tokens (`html>`, `<head>`, `<body`) or
  ST-Prompt-Template's opener (`<%`). Those are refused and logged (`pageCodeTokenAdded`,
  `shared/rendered-region.js`), because the page would run that text: TavernHelper renders such a reply as
  an unsandboxed web page, and ST-Prompt-Template evaluates every message of the final prompt — chat history
  included — and a message when it is shown. The same line holds for everything else mvu-helper writes out
  of `stat_data`: a stat box line carrying a token is left out, its member names expand `{{user}}` and
  `{{char}}` and no other macro, and the cast block and scene roster mvu-helper adds to the prompt go out
  with every `<%` broken to `< %`.
- Use `console` and `crypto`.

**Per type:**

- *GameLogic Plugin* — `requires` naming an interface the card does not publish refuses the install, by
  name. A relay's output goes through `Mvu.parseMessage` exactly like a POST block, and meets the same Zod.
- *StatusMenu Engine* — formatters are `(stat, root) => value`; actions are `(args, snapshot) => patch[]`.
  A malformed patch refuses the whole action rather than applying part of it.
- *EventPack runtime* — `eventpack.cjs` evaluates the WHEN-DSL itself; pack text is never handed to
  `eval` or `new Function`.

---

## 3. The StatusMenu frame — menu documents

TavernHelper renders any fenced `<html>` document in a message as an iframe with no `sandbox`, and hands it
the page's lodash, every TavernHelper function, `SillyTavern.getContext()` and `Mvu`. So mvu-helper never
lets it render a StatusMenu Pack's document:

- **The lift.** At install, each fenced document leaves its regex row for a silent lorebook entry,
  `[MVU_StatusMenuBody:<row>]`, and the row is written with no fence — TavernHelper has nothing to render.
  An install is **refused** when any row it would write still carries `html>`, `<head>` or `<body`
  (TavernHelper's own render test).
- **The frame.** mvu-helper mounts each document in `<iframe sandbox="allow-scripts allow-modals">`, with no
  `allow-same-origin`, inside a wrapper frame of its own with the same sandbox. The menu's origin is opaque:
  every read of `window.parent` or `window.top` throws, and SillyTavern's cookies and storage are out of its
  reach. The wrapper's one policy, `frame-src 'none'`, keeps the menu's frame on the menu's own document:
  sent to any other address, the load is refused before a request leaves the browser. The wrapper relays
  what the menu posts to its parent, and the answers to it, unchanged; the page posts the state straight to
  the menu's window.
- **The policy.** `default-src 'none'`, inline script and style only, `connect-src 'none'`, and images only
  from `data:`, `blob:` and the image-source list on the Main tab (default `http: https:`). `<script src>`,
  `import()` and `eval` are refused.
- **The bridge** — the frame's whole world besides drawing: formatter calls, actions (applied through MVU
  and Zod, §2), one lorebook entry by key or comment, and any image SillyTavern serves, read by the page only
  when same-origin, never under `/api/`, only an `image/*` answer, at most 16 MB — other characters' card
  PNGs included, with the card data stored inside them. Every request is answered for a contained menu frame
  only (a window of an iframe carrying the menu sandbox — the wrapper's, or the menu's inside it — whichever
  host mounted it); one from any other window is refused and logged as a warning, and one whose sender no
  longer exists (a menu removed by a re-render of its message after it posted, delivered with no `source`)
  goes unanswered and is logged at verbose (`menuBridgeSenderVerdict`).
- **No fallback.** A document that fails in the frame is not re-hosted uncontained; the log names the fix.
  galgame-companion mounts the same frame (`MvuHelper.statusMenuFrameSource()`), never its own copy.
- **The ceiling.** The frame cannot reach SillyTavern, but anything it is HANDED — the pushed `stat_data`,
  any entry of the card's primary lorebook (its config and engine text included), any image the bridge
  reads — can leave the browser two ways: silently, in the URL of an image it draws, to any host the
  image-source list on the Main tab allows (default: every http and https host); and visibly, in a link the
  page opens in a new tab, which it does for any http(s) address a menu names within a few seconds of the
  player's last click or key press anywhere in SillyTavern. Loading another page in its own frame is not a
  third way: the wrapper refuses it before a request is sent (measured 2026-10-26).
- A regex row claiming the menu that mvu-helper did not write is rendered by TavernHelper as before; the
  log names it once per chat.

---

## 4. Event Packs — data, not code

An Event Pack has no engine, no schema and no regex. Installing one writes event **definitions** into
`stat_data.EventPack` and nothing else; live game state is never touched by install, upgrade or uninstall.

- Every trigger key must carry the pack's own prefix; a collision with another pack's or the game's keys
  refuses the pack.
- When an event fires, its `writes` reach only the paths the card's engine declares, under the rules it
  declares, and only records whose key carries the pack's prefix. A write is data the engine applies — a
  pack cannot express a code path.
- Its lorebook bodies are held to exactly three EJS forms (the `if (false)` wrapper, the flat
  `EventArmed` gate, the closer); any other `<%` refuses the install. An Event Pack is the one pack type
  whose entries cannot carry template code.

---

## 5. Side panels, GameLogic regex rows and the schema

A `panel` section is declarative. mvu-helper builds the panel's DOM itself and writes every author string
as text (`textContent`), never as markup, so a panel cannot carry a script or an element of its own.

A GameLogic Pack's `regex` rows are there to hide or restyle the game's own output. A row whose
`replace_string` carries `html>`, `<head>` or `<body` — TavernHelper's own render test — would be rendered
as an unsandboxed web page holding the page's globals, so validation refuses the pack, naming the row and
the token (rule 10). The check covers every row whatever its destination flags, because a flag is the card
owner's to flip after install. Styling markup (`<div>`, `<details>`, `<span style>`) passes. A document
meant to render belongs in a StatusMenu Pack, whose install moves it into the contained frame (§3). The
check does not look for ST-Prompt-Template's `<%`, so a row carrying one still installs; the install warning
reads its code first (§6).

A GameLogic Pack's or Plugin's `schema` is installed as the card's `Scheme` TavernHelper script, which
TavernHelper runs on the page, unsandboxed, on every chat load. So the script may only declare a schema:
before it is judged or installed it is cut down to an allow-list (`gamelogic-pack-schema-allowlist.js`, run
inside `judgePack`, which every import and install goes through). It keeps the one mvu_zod import;
declarations whose values are built only from `z.<member>(…)` calls on a fixed list of members, literals and
names declared earlier in the file; one `registerMvuSchema(…)` call, bare or in `$(() => { … })`; and
comments. Everything else is removed statement by statement, with every statement that uses a name it
declared, and the rest installs; the removals are reported, and a toast names the lines. That is the schema
MvuStatMenuBuilder generates, plus `z.looseObject`.

- The member list stops `z.constructor.constructor('…')()`, which starts with `z.` and runs any text.
- A value may name only what the file declared, so `fetch`, `window` and `eval` are out of reach, and an
  escaped name (`\u0066etch`) is not a name the scanner reads.
- No function but the register wrapper, no `[ ]` lookup, no template string, no `__proto__` key.
- A `//` comment ends where JavaScript ends it, at `\n`, `\r`, U+2028 and U+2029, so no code hides after a
  line break the scanner missed. `</script`, `<script`, `<!--` and `-->` are removed from comments and
  strings, so the text cannot close or open a script element it is embedded in.
- The filtered text is scanned again and must come back clean, or none of it installs.

This scan does not hunt for hostile names, so building a name out of pieces does not get past it: the
grammar it keeps has no way to call anything but zod.

---

## 6. Open — where a pack still reaches past the Worker and the frame

These routes let a pack reach past the Worker and the frame: its code runs with the page's full reach —
SillyTavern's backend as the user, every chat, every setting — and its macros write SillyTavern's settings.
They are listed here so nobody describes the boundary as complete; §2–§5 do not close them, and the install
warning only shows them.

**EJS in lorebook entries.** GameLogic Packs, Plugins and StatusMenu Packs can ship entries with EJS, which
ST-Prompt-Template runs while building the prompt; it is how a card chooses what reaches the model, so entries
keep it. Two measures meet this route, and neither closes it.

**Turn on ST-Prompt-Template's "Environmental isolation" setting** — it is off by default. With it on
(ST-Prompt-Template 1.17.8.2 or later, which carries [PR #6](https://github.com/zonde306/ST-Prompt-Template/pull/6)),
templates run in a sandboxed document whose policy refuses network requests, and `$`, jQuery, localforage and
SillyTavern's executing members are withheld; School's templates run unchanged under it. By ST-Prompt-Template's
design every other page global still reaches a template whole — `TavernHelper`, whose functions write scripts and
run slash commands, and each extension's own object, mvu-helper's `mvuHelper` (`runLlmCall`, `runPostPass`)
included — and `SillyTavern.extensionSettings` stays readable. With the setting off, a nested frame restores
`fetch` outright (measured 2026-08-06).

**The install warning.** Before an install, repair or upgrade writes a pack from the library, mvu-helper reads what
it writes: each entry's content, keys and secondary keys, and each regex row's replacement and trim strings, a
StatusMenu Pack's documents lifted out to their markers. When the template code or SillyTavern's macros there
reach SillyTavern's settings, reach outside this chat, or use TavernHelper, SillyTavern or the page in a way no name
can be read from, it asks first, before any other question or write, in a danger dialog naming each find. Cancel
installs nothing and changes nothing; Install anyway goes on to the install; each answer leaves a warn line naming
the pack and every find. A pack that cannot be read is not installed. The dev loop never asks, and Event Packs are
exempt by their lint (§4).
- **Passes:** TavernHelper's and SillyTavern's members that read, or write only this chat (each member is judged
  by its class); a variable call whose store is this chat's (TavernHelper's `type`, ST-Prompt-Template's `scope`);
  and mvu-helper's settings door, `MvuHelper.settings`, which an honest pack reads instead of `extensionSettings`.
- **Warns:** SillyTavern's settings objects; a member kept in its settings, or reaching any chat, book or character by
  name, and a member the class lists do not hold; ST-Prompt-Template's `execute`, `evalTemplate`, `define` and
  `activateRegex`; the page's own reach (`fetch`, `document`, `eval`, `Function`, `.constructor` and the rest);
  SillyTavern's global-variable macros.
- The rules and every member's class: `plans/pack-install-warning.md` §3 and its appendices.

The warning is no boundary. It reads names, never what a value holds, so a name built out of pieces at run time,
or a function reached through an object an allowed call returns, is not seen. It does not name another extension's
global, mvu-helper's own `mvuHelper` among them. And a template can run another entry's text: `getwi` renders any
entry of any book as a template, and `activewi` puts any entry into the prompt, so the silent entries an install
writes (panel, layout, engines, a menu's lifted documents) and the library's copy of every pack hold text the warning
never reads; School loads its heroine cards with `activewi`, so neither call warns. What the warning gives is an
honest pack's reach, shown at the one moment the user decides.

**`<%` in a regex row.** The GameLogic row check (§5) and the StatusMenu document lift (§3) look for
TavernHelper's render tokens only, so a GameLogic or StatusMenu Pack row whose replacement carries `<%`
installs, and ST-Prompt-Template evaluates it once the row's output is part of the final prompt. The install
warning reads that code first, as written and with its character references decoded, as it reads an entry's.

**SillyTavern's macros.** SillyTavern runs its macros over an entry's content when it fires, its keys on every scan,
and a regex row's replacement and trim strings, with no template code at all. `{{setglobalvar::…}}` and its family,
and 1.19.0's `{{$name = …}}`, read and write SillyTavern's global variables, kept in its settings. A pack's rows
are written with the macro option off, so their find patterns run none. The install warning names each of these
macros, a read as well as a write.

**A pack's prompt asking a model for page code.** A pack's entries are prompt text, and they can ask the
narrator for an `<html>` fence, which TavernHelper renders as an unsandboxed page, or for a `<%`, which
ST-Prompt-Template runs when the reply is shown and again when it goes back into the prompt. mvu-helper does
not check the narrator's reply. It does check what it writes into a reply from a model's output: a POST
call's `<UpdateVariable>` block carrying `html>`, `<head>`, `<body` or `<%` is neither written nor applied,
and the call's warning names the token (`postBlocksForReply`, `small-llm/extra-llm-calls-core.js`). A model
can also write a markdown image whose URL the browser then fetches; that reaches the network, not the page.

**Outside every pack, by design:** the card's own TavernHelper scripts and regexes, and a preset's scripts.
Those are the card's and the preset's; installing no pack changes them.

---

## 7. How each layer is proven

Every guard below was seen to FAIL with its protection removed on purpose (mutation), then restored.

| Layer | Tests | Live, in Chrome on SillyTavern |
| --- | --- | --- |
| Capability block | `engine-capability-block.test.js` runs the attack payloads against the real block; `engine-capability-block-reporter-lock.test.js` | prototype-walked `fetch` closed, 2026-09-18 |
| Engine Worker | `logic-engine-core.test.js` (scopes, error containment, call routing) | realm escapes measured and closed, 2026-08-06 |
| Engine frame policy | `engine-frame-core.test.js` — the policy's shape, the Worker's import graph against the listed files, and the host's frame, realm and teardown | 2026-10-02, from inside the Worker: `import()` of a remote URL, SillyTavern's own `script.js`, an extension module with a query string, and a `data:` module all refused; `new Function` and `eval` still run; a cached-module reporter swap refused while the next blocked reach was still reported; School v4 loads and answers. 2026-10-03, a second install: the same refusals, and a real generation turn whose check was dealt by PRE and resolved by the engine in the same reply |
| StatusMenu frame | `statusmenu-frame-core.test.js` (the wrapper's policy, its relay and the menu-window rule among it), `statusmenu-pack-core.test.js`, `rendered-region.test.js` | 2026-09-23 attack probe: every parent, top, storage, cookie and network reach refused; 2026-10-26: a load the menu's frame starts itself refused by the wrapper before any request is sent (`net::ERR_BLOCKED_BY_CSP`) |
| Event Packs | `event-pack-core.test.js` | — |
| Install warning | `template-reach.test.js` — each rule and exemption, the macros, acorn's tokenizer agreeing over every case and every template of School's two packs, which report nothing; `pack-install-warning-core.test.js` — what an install writes as the scan reads it, each lane's reading, the question, the warn line, and source gates (each install asks first, a pack is written only behind its asking handler, an unreadable pack answers no, the dev loop never asks); `popup-api-boundary.test.js` — a danger dialog opens on Cancel, and only a safety question is one | 2026-10-27, local ST: every lorebook, card book and regex row there (1940 texts, with 7537 keys, trim strings and macro find patterns) scanned clean in 152 ms; probe packs on all three lanes warned before any other question — `extensionSettings`, a key's `{{getglobalvar}}` and `TavernHelper.deleteWorldbook`, a fenced menu row name's `{{setglobalvar}}` — Enter answered Cancel with nothing after, and the card's book and regex rows hashed the same before and after; School's packs asked nothing |
| Side panel | `side-panel-core.test.js` | — |
| Pack gates' engine read | `artifact-source-gates.test.js` — a menu gated without its exports throws, only function exports count, no in-page executor in the gate module, nothing in `src/` imports the in-process reader, the page callers pass the Worker reader, the check Worker never touches the running engine and always ends; `artifact-source-import.test.js` — no reader throws, the reader gets the assembled text | 2026-10-03: an engine calling `fetch` at load refused inside the check Worker (logged `[artifact check] … BLOCKED`), nothing ran on the page; an endless loop reported after 10 s with the page still running; Worker count back to baseline; a real ZIP pick in the GameLogic Packs tab judged School's menu clean and refused a copy whose engine calls `fetch`; a StatusMenu export from the card passed through the same read |
| Schema allow-list | `gamelogic-pack-schema-allowlist.test.js` — the builder generator's output, both blank skeletons and every allowed form kept byte for byte; each hostile form (a page call, `z.constructor.constructor`, a function handed to zod, the register wrapper running more, a foreign import, a `__proto__` key, an escaped name, a template string, a statement JavaScript continues onto the next line) removed with the rest kept; a `//` comment ended at U+2028, U+2029 and `\r`; script markers removed from comments and strings; whatever uses a removed name removed; `judgePack` judges and returns the filtered pack; `tools/test-artifact-assembler.mjs` holds School's schema and both plugin probes' schemas whole | — |
| Page-code guard | `page-code-guard.test.js` — a text swap or audit block that would add `html>`, `<head>`, `<body` or `<%` refused, a token completed across a swap caught, a token the reply already carried left alone; a POST block carrying one neither written nor applied; a stat box line carrying one left out; member names expanding `{{user}}` and `{{char}}` only; the cast block and scene roster sent with their openers broken; a bridge request from a window that is no menu frame refused, checked before every lane, and one whose sender no longer exists unanswered and logged at verbose; the model's picture text sent to /sd without macro braces, the prefix's kept; every toast shown as text and no direct `toastr` call; MVU loaded from one release tag | — |
| GameLogic regex rows | `gamelogic-pack-core.test.js` rule 10 — each render token refused, styling markup accepted, destination flags exempt nothing, StatusMenu rows left to their lift; `tools/test-artifact-assembler.mjs` holds School's own rows clean | 2026-10-03, the deployed validator: a fenced GameLogic row refused, a styling row and a StatusMenu row accepted |
| Prototype keys | `prototype-key-guard.test.js` — the shared walkers, the seed merge and the deep clone, the op check every patch lane passes before MVU, plugin state names and suggestions, and the path readers (side panel, image paths, menu formatter scopes, plugin interfaces), each checking a fresh `{}` for pollution; `card-sync-core.test.js` (`force`), `logic-engine-core.test.js` (declared paths), `statusmenu-pack-core.test.js` (menu patches), `extra-llm-calls-core.test.js` (POST's undo writes) | 2026-10-19, the deployed build: ops through `__proto__` and `constructor/prototype` dropped by the op check with their reason while the ordinary op beside them was kept; the walkers and the seed merge refused them; `constructor` refused as a state name; nothing reached `Object.prototype`; School v4 loaded and the dev loop's full apply ran clean |
