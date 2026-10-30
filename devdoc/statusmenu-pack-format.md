# StatusMenu Pack format — what mvu-helper accepts

Audience: anyone producing a **StatusMenu Pack** file — by hand, or from a tool such as
MvuStatMenuBuilder. This document is the HOST's side of the contract: the fields mvu-helper reads,
what it does with each, and what it refuses. Plan/spec: `plans/executed/gamelogic-pack-v2.md` §3/§9/§10.

A StatusMenu Pack is ONE JSON file carrying the display half of a game: the **StatusMenu Engine**
(the code behind menu cells and buttons) and the **layout declaration** (what the menu draws). The
player installs it from the **StatusMenu Packs** tab; one is active per card.

---

## 1. Two namespaces, and the difference matters

**Top level is the host's namespace.** Every key there is addressed to mvu-helper, which reads it,
acts on it, and warns at anything it does not recognise — in the report AND in a yellow toast, because
what it names is a piece of your file that did not install:

> `unknown TOP-LEVEL section "x" — the file declares format "1.0" and this mvu-helper understands 1.0.`
> `That section is NOT installed; every other section is.`

**The rest of the file installs.** An unrecognised section never refuses the artifact — that is what
lets a later format add a section without a migration and without a compatibility flag: an older
helper names what it skipped and installs the rest.

The warning ends with one of two sentences, and they mean opposite things:

| Ends with | Cause | What to do |
| --- | --- | --- |
| *built for a NEWER mvu-helper* | the file's `format` is above the number this helper understands | update mvu-helper |
| *top level is the HOST namespace* | same format, so nothing newer is expected here | the field is misplaced — move it inside the section that carries it |

A file whose `format` is newer but whose sections are all recognised warns too: a section REDEFINED at
that number would be read the old way here, and the helper has no way to name which one.

**Anything a downstream reader consumes travels inside a section the host carries verbatim.** There
are three, and the host never inspects the inside of any of them:

| Section | Carried to | The host's whole involvement |
| --- | --- | --- |
| `engine` | the Worker | store the text, boot it, call its exports by name |
| `entries` | the card's lorebook | copy each entry's fields, prefix the comment |
| `layout` | the card's renderer | store it, write it into one lorebook entry |

This is why a renderer may add fields freely: they go inside `layout`, where no host check applies
and no host release is needed. Put one at top level instead and you get both halves of one bug — a
warning that says "ignored", and a field that genuinely never reaches the renderer, because install
writes `layout` and nothing else.

---

## 2. Top-level fields

| Field | Required | What the host does |
| --- | --- | --- |
| `format` | **yes** | File-format version, `"<major>.<minor>"`. No silent default. |
| `packType` | **yes** | Must be `"statusmenu"`. |
| `id` | **yes** | kebab-case. It rides the lorebook needles, the `[data-pack]` CSS scope and locale keys, so it is FROZEN once published. `"registry"` is reserved. |
| `name` | **yes** | Display name, any script. Shown in the library list. |
| `description` | **yes** | One line, shown in the library list and the install dialog. |
| `version` | no (warned) | Compared segment-by-segment on re-import to tell an upgrade from a re-install. Absent means no update can be detected. |
| `builtWith` | no | A tooling receipt. Stored, never interpreted. |
| `targetsPackId` | no | A LABEL naming the GameLogic Pack the menu was drawn against. **Never a gate** — the host does not compatibility-match a menu to a game. |
| `engine` | no | The StatusMenu Engine as ONE string. Needs a `v<major>.<minor>[.patch]` marker in its leading comment. |
| `layout` | no | The renderer's declaration object. Carried verbatim; see §4. |
| `entries` | no | Lorebook entries the layout reads at render time. |
| `regex` | no | Regexes that ARE the menu surface; see §5. |

Sections belonging to another `packType` are refused by name: a StatusMenu Pack may not carry
`schema`, `state`, `exposes`, `requires` or `optionalUses`.

---

## 3. The engine

One self-contained JavaScript string that declares its version and ends in a `module.exports` of
two groups:

```js
// my-menu StatusMenu Engine
const ENGINE_VERSION = 'v1.0';
module.exports = {
    ENGINE_VERSION,
    formatters: {
        moneyDisplay: (stat, root) => 'Ɉ ' + getV(root, 'Mainchar.Money', 0),
        profileKey: (stat, root, scopePath) => scopePath.split('.').pop(),
    },
    actions: {
        unequip({ slot }, stat) { return [{ op: 'delete', path: 'Mainchar.Equipment.' + slot }]; },
    },
};
```

- **`ENGINE_VERSION` is a declaration, not a comment.** Rule 3 reads it off a line-anchored
  `const ENGINE_VERSION = '…'` string literal, and the loader reads the exported value off the
  running module; a version written only in a comment satisfies neither.
- **Formatters are `(stat, root, scopePath) => value` and PURE.** `root` is the whole `stat_data`;
  `stat` is the value at `scopePath`, the path the renderer scoped that cell to — for a cell inside
  a collection that is the ITEM's own path (`Classmate.Airi`), which is how a formatter knows which
  item it draws; `''` means the whole state. mvu-helper gives the path no meaning of its own. They
  compute display values and never write.
- **Actions are `(args, statSnapshot) => patch[]`.** They never write either — they RETURN patches
  and mvu-helper applies them through the card's MVU/Zod rail, logging every operation. An action
  returns every mutation its gesture implies, derived values included: a menu click starts no turn,
  so nothing recomputes afterwards.
- It runs in a **Worker**, with no DOM, no `window`, no network. Anything the engine needs it must
  define itself.
- A malformed patch refuses the whole action rather than applying part of it.

The engine text is stored in the card's own `[MVU_StatusMenuEngine]` entry. If a StatusMenu Engine
is already there and the host does not own it, an engine-carrying pack **refuses** rather than
overwriting it.

### 3.1 In a workspace: several files, one engine

In a workspace (the source folder `npm run dev` assembles — `plans/executed/artifact-development-workflow.md`),
`engine/` may hold several files. `pack.json`'s `engineOrder` names them in load order, and the
assembler joins them into the one `engine` string above. They run as ONE script: a name declared at
the top of one file is visible to every file after it, and a name declared at the top level of two
files is a SyntaxError that stops the whole engine from loading. A file in `engine/` that
`engineOrder` does not name, or a name with no file, is refused.

MvuStatMenuBuilder (2.7.0 on) keeps a menu's engine in two files, each with one owner. mvu-helper's
**Add New Blank Packs** StatusMenu skeleton ships the same two, its `layoutFormatters.cjs` empty
until the first refresh zip replaces it:

| File | Owner | Holds |
| --- | --- | --- |
| `engine/layoutFormatters.cjs` | the builder — every layout export rewrites it | one formatter per cell formula, and the helpers they call, all inside one function; the file declares ONE name, `LAYOUT_FORMATTERS` |
| `engine/statusMenuLogic.cjs` | you — the builder writes it once, as a starter | `ENGINE_VERSION`, the actions, their inputs, and any formatter written by hand; it exports `formatters: { ...LAYOUT_FORMATTERS, ...HAND_FORMATTERS }` |

`engineOrder` is `["layoutFormatters.cjs", "statusMenuLogic.cjs"]` — the formatters load first,
because the engine reads them.

- **Never edit `layoutFormatters.cjs`.** The next export replaces it. Change the cell's formula in
  the builder and export again.
- **A hand-written formatter goes in `HAND_FORMATTERS`.** One whose name the layout also computes is
  refused when the engine loads, and the error names both files; verify reports it as the engine
  throwing while loading.
- **`ENGINE_VERSION` lives in `statusMenuLogic.cjs` alone.** The generated file declares none.

**When the layout changes** — a new cell, a new formula:

1. Change it in the builder.
2. Export **Refresh layout .zip** (`statusmenu-layout.zip`) and extract it into
   `<workspace>/statusmenu/`. It carries `layout/layout.json` and `engine/layoutFormatters.cjs` and
   never `statusMenuLogic.cjs` or `pack.json`, so it is safe over work in progress.
3. Run verify, or let `npm run dev` pick it up. A cell naming a formatter the engine does not export
   is an error naming the cell.

Your file changes only for what the builder cannot write: an action (a button, a row verb), its
inputs, or a formatter written by hand.

**The menu shell is a third export.** `regex/StatusMenu.json` — the regex that draws the menu — is
written by the bootstrap zip only. When the builder's menu runtime changes, re-emit it with the
builder repo's `tools/emit-pack-host-shell.mjs`; a refresh zip never carries it.

**A workspace bootstrapped before 2.7.0 moves once:** put `"layoutFormatters.cjs"` before
`"statusMenuLogic.cjs"` in `engineOrder`; in `statusMenuLogic.cjs`, delete the formatters the layout
computes, move any written by hand into `HAND_FORMATTERS` (with the load-time name check a fresh
bootstrap's starter carries) and export `formatters: { ...LAYOUT_FORMATTERS, ...HAND_FORMATTERS }`;
then extract a refresh zip.

---

## 4. The layout

`layout` is an object, and the host requires exactly one thing of it: that it contains no
`customLogic` at any depth. Menu logic lives in the engine, reached by name, so the layout stays
pure data — a layout entry is hand-editable, and a hand-editable code channel is not one.

Everything else inside is the renderer's business. The declaration is expected to name which
renderer draws it and which version of that renderer's schema it follows, so an unknown renderer can
say so rather than guess; the host stores those fields without reading them. The current declaration
shape belongs to MvuStatMenuBuilder — see `plans/pack-authoring-plan.md` §B.2 in that repo.

**Install writes the layout whole** into one entry, `[StatusMenuPack:<id>] (Layout)`. A renderer
therefore finds everything the pack declared in one place.

---

## 5. Entries and regexes

**`entries`** — each needs a non-empty `comment` (uninstall finds it by that) and a string `content`.
The installer prefixes every comment with `[StatusMenuPack:<id>] `, so the comment must NOT already
start with a control prefix (`[MVU_`, `[GameLogicPack:`, `[StatusMenuPack:`, `[GameLogicPlugin:`).
Every other field is preserved as written; only a source `uid` is dropped.

**`regex`** — an array of TavernHelper regex objects. Each needs a unique non-empty `script_name`
(its identity for upgrade and uninstall) and a non-empty `find_regex`. A pattern that does not
compile warns; so does `destination.prompt`, which rewrites text on the way to the model rather than
on screen. Regexes are written at install time only, and installing them reloads the chat.

**A row that carries a document is LIFTED, never written as shipped.** A `replace_string` holding a
fenced block must be exactly what MvuStatMenuBuilder exports: a rendered-region container
(`<div … data-mvu-helper="<region>">`), the `<!-- mvu-helper:begin <region> -->` / `end` pair inside
it, ONE ``` fence between them, and nothing else but comments. Install moves that text into its own
silent entry (§6) and writes the row as the same container with no fence, naming the pack and the
row — so TavernHelper has nothing to render, and mvu-helper mounts the document in its own contained
frame (§7). The install is REFUSED, naming the row, when any row it would write still carries
`html>`, `<head>` or `<body` (TavernHelper's own render test), when a fence sits outside a wrapper,
when a wrapper holds two fences, or when a fence is empty. A pack may ship several such rows, each in
its own region.

---

## 6. What install writes, and what it never touches

These entries in the card's own book, plus one registry record:

```
[StatusMenuPack:<id>] (Layout)          the whole layout declaration
[MVU_StatusMenuEngine]                  the engine text        (only when the pack ships one)
[MVU_StatusMenuBody:<row script_name>]  one lifted row's text, verbatim (one per row that carried a document)
[StatusMenuPack:Registry]               activeMenuId · ver · installedComments · engineOwned · engineFingerprint ·
                                        installedRegexNames · shellOwned · liftedRows · identity · installedAt
```

Every one of them is a silent data carrier (`enabled:false`, no keys): nothing here reaches a prompt.

The registry is the record of what this pack owns, and uninstall removes exactly that — its recorded
entries, its own engine text, its lifted documents, its own regexes by name — then compares what it
removed against a sweep for its needle, so a mismatch is reported rather than left behind. It never
touches the GameLogic Pack, the global MVU script, or entries it did not write. The release export
puts each lifted document back into its row byte for byte, so export(install(A)) is A. The engine's
fingerprint is how the menu's row tells its own engine from a dev upload: while another copy is there, the
row shows Drift and offers Repair, which writes the pack's copy back.

A pack shipping no `regex` never touches the card's regexes at all.

---

## 7. Where the menu runs — the contained frame

A lifted document runs in a frame mvu-helper creates in the message, `sandbox="allow-scripts
allow-modals"` with no `allow-same-origin`, inside a wrapper frame of mvu-helper's with the same sandbox:
its origin is opaque, so reading anything on `window.parent` or `window.top` THROWS, and cookies, storage
and the network are closed. The wrapper's one policy, `frame-src 'none'`, keeps the document's frame on
the document: sent to any other address, the load is refused before a request is made, the frame shows
the browser's error page, and mvu-helper warns naming the menu. The wrapper relays, unchanged, what the
document posts to its parent and the page's answers to it; the document may also post to `window.top`
directly. The page posts the state push, and its answers to what the document posted to `window.top`,
straight to the document's window (`event.source` is `window.top`); everything else arrives through the
wrapper (`event.source` is `window.parent`, `event.origin` `"null"`). So a document reads a message by its
`type`, not by who sent it. What the document CAN reach is exactly this:

| direction | message `type` | payload | answer |
| --- | --- | --- | --- |
| frame → page | `mvu-helper:statusmenu-formatters` | `{ requestId, requests }` | `-result` `{ ok, map, missing }`, or `{ ok: false, reason }` when the page cannot serve it yet (MVU not loaded, no message, no `stat_data`) |
| frame → page | `mvu-statusmenu-action` | `{ requestId, action, args }` | `-result`; a landed action also pushes the new state to the asking frame |
| frame → page | `mvu-statusmenu-action-inputs` | `{ requestId, action, args }` | `-result` |
| frame → page | `mvu-helper:statusmenu-lorebook-content` | `{ requestId, key }` | `-result` `{ content }` — ONE entry's content, matched on `keys[]` or `comment` |
| frame → page | `mvu-helper:statusmenu-image` | `{ requestId, url }` | `-result` `{ blob }` — a SillyTavern-origin image only, never `/api/`, only an `image/*` answer |
| frame → page | `mvu-helper:statusmenu-link` | `{ url }` | none — the page opens the URL in a new tab: http(s) only, only from a menu frame, only right after a click |
| frame → host | `mvu-helper:statusmenu-ready` · `-height` · `-overlay` · `-error` | `{}` · `{ height }` · `{ open }` · `{ message, source, line }` | `ready` is answered with `statusmenu-state` |
| wrapper → host | `mvu-helper:statusmenu-blocked` · `-reloaded` | `{ url }` · `{}` | none; the wrapper's own — the relay passes neither type from the document |
| page → frame | `mvu-helper:statusmenu-state` | `{ mid, statData }` | — |

The host sends `statusmenu-state` when the document says it is ready (every time it starts, a reload
inside its wrapper included — before its images finish loading), when TavernHelper announces `Mvu` (a
chat opens before its card's MVU script runs), after every MVU update, after every save mvu-helper makes
(the turn's RES1 and RES2, a landed action, the PRE apply, a sync pass), and within 2 seconds of a variable
edit nothing announces (TavernHelper's variable editor, or another script's `Mvu.replaceMvuData` or
`Mvu.setMvuVariable`). For that last one the host compares the message's variables object with the one it
last sent and skips an unchanged one, so an idle chat sends nothing. A menu needs no polling of its own.
Every send but `ready`'s waits while mvu-helper's write at the turn's end is about to re-render the menu's
message: that write replaces the menu with a new one, which is sent the state when it says it is ready,
so the waiting send goes only to a menu still on the page.

A prelude runs before the document and answers the host calls a builder menu makes, from the pushed
state: `getCurrentMessageId`, `getVariables`, `waitGlobalInitialized`, `Mvu.getMvuData`,
`Mvu.events.VARIABLE_UPDATE_ENDED` with `eventOn`, `_.get` / `_.set`, an in-memory `localStorage`, and
`MvuHelperFrame.lorebookContent(key)`. It posts `ready` as soon as it has run, then the height, a
full-screen popup opening or closing, and any uncaught error. While a popup is open the frame is lifted over the whole screen, in the browser's
top layer, so SillyTavern's top bar and send form sit under it. Closing it is the menu's own: the host
adds no Escape key or click-outside close. An `<img>` pointing at
SillyTavern is read through the page and shown as `blob:` — SillyTavern sends
`Cross-Origin-Resource-Policy: same-origin`, so a direct load from the frame is dropped. A click on an
http(s) `<a href>` is handed to the page, which opens it in a new tab: the frame may open no tab itself, and
the wrapper refuses any page loaded inside it.
A link the menu handles itself (its click handler calls `preventDefault`) and an in-page `#anchor` stay the
menu's. Macros such as
`{{user}}` are expanded at mount, as SillyTavern's regex engine expanded them; `{{match}}` and `$1`
are not, because a mounted document replaces no match.

The Content-Security-Policy is `default-src 'none'`, inline script and style only, `connect-src
'none'`, and `img-src data: blob:` plus the user's global image-source list (Main tab; default
`http: https:`). A `<script src>`, `import()` or `eval` is refused.

**A document that reads `window.parent` outside a `try` dies at that line** and is not re-hosted
uncontained; mvu-helper warns naming the `SecurityError` and the fix. Every MvuStatMenuBuilder export
from 2.5.2 on reads its own window first.

---

## 8. Mismatch is a warning, never a refusal

A StatusMenu Pack is built against one game, and nothing polices the pairing. Install a menu on a
card whose game does not match and the menu still renders: an unresolvable variable path, an unknown
cell type, a formatter the engine does not export, a lorebook key that resolves to nothing — each
renders raw or static and logs ONE warning naming what it could not resolve.

That is the entire compatibility story. A pack must not be able to break the menu, and a wrong
pairing should LOOK obviously wrong rather than look like a broken game.

---

## 9. A minimal valid file

```json
{
  "format": "1.0",
  "packType": "statusmenu",
  "id": "my-menu",
  "name": "My menu",
  "description": "A status menu for the Example game.",
  "version": "1.0",
  "engine": "// my-menu StatusMenu Engine  v1.0\nmodule.exports = { formatters: {}, actions: {} };",
  "layout": { "kind": "tabbed-grid", "format": "1.0", "tabs": [] }
}
```
