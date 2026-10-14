# Running on any game

> A plugin is written for any game. ArtificKoi shows up as a real host, not as a rule. See [Written for any game](technical.md#written-for-any-game).

Your plugin gets installed on a card you didn't write. 2 questions decide whether it does anything useful there:

1. **Which game is this?** Ask the engine's identity.
2. **Where does this game keep the thing I need?** Ask `exposes`.

## Never guess

"Look through `stat_data` for objects with a `Name`" sounds generic. It's a guess in disguise.

Items have names too. A game that calls the field `CharName` reads as zero cast, with no error, just nothing. And every plugin ends up carrying its own guessing code, and each one drifts in its own way.

Identity gives you a sharp tool for the games you know. `exposes` gives you a working one for the games you don't.

## Which game is this

Every game engine declares its own identity: `ENGINE_NAME`, `ENGINE_TYPE` (its family: RPG, Love, School…) and `ENGINE_VERSION`. MVU Helper reads them from the engine's exports. How a game declares them is on [The hooks in detail](../gamelogic_engine/hooks.md).

| You're writing… | You ask… |
| --- | --- |
| resolver or `renderPanel` code | `ctx.engine` > `{ name, type, version, packId }` |
| EJS inside an entry | `globalThis.MvuHelper.engineInfo()` > the same fields, plus `exposes` |
| plain text inside an entry | `{{mvuhelperEngineName}}`, `{{mvuhelperEngineVersion}}` |

- **Match on `name`.** `type` tells you the family, but 2 games of one family can keep their state completely differently. That's what `exposes` is for.
- **The version is information, not a gate.** Only check it to work around one specific known change, and say so in a comment.
- **`null` means unknown.** A card with no game engine, or an engine that declares nothing. Treat it as an unknown game: fall back to prose, or show nothing. **Never send a guessed channel or path.** A made-up `/Intent/` write doesn't fail loudly. It's just ignored.

### The ordering trap

EJS runs FIRST, and macros like `{{mvuhelperEngineName}}` are filled in AFTER. So EJS can print a macro, but can never read one:

```ejs
<%_ if ('{{mvuhelperEngineName}}' === 'School') { _%>   ← ALWAYS FALSE. EJS sees the raw token
```
```ejs
<%_ const _jrEngine = (globalThis.MvuHelper && globalThis.MvuHelper.engineInfo()) || {}; _%>
<%_ if (_jrEngine.name === 'School') { _%>              ← right. Code that branches uses the global
```

It's like checking a form for the customer's name before the clerk fills it in. The blank is still blank when you look.

## Where does this game keep it

The game says where things live. Your plugin says what it needs. MVU Helper matches the 2.

In the game's `pack.json`:

```json
"exposes": { "cast@1": "Classmate" }
```

In your plugin's `pack.json`:

```json
"requires":     ["cast@1"],
"optionalUses": ["clock@1"]
```

- **`requires`** > your plugin means nothing without it. If the game doesn't expose it, **install is refused**, and the message names the interface.
- **`optionalUses`** > your plugin can still do something useful without it. It installs, and says it runs without it. **And you owe the player that path.** Declaring something optional and then crashing on `undefined` fails while they play, instead of at install.

An interface name is `<name>@<major>`, lowercase, like `cast@1`. It's checked when your file is imported. A bad name could never match anything, and the install message would blame the game for your typo.

MVU Helper is a blind matchmaker. It knows no interface names of its own. It compares strings and hands back paths. It never checks what's at the path, so if the game exposed the wrong one, you read `undefined`.

- **In a resolver or `renderPanel`:** `ctx.exposes` holds *your* declarations, matched. Nothing else.
- **In EJS:** `globalThis.MvuHelper.exposes()` gives the game's whole map. Read only what you declared anyway. An interface you didn't declare gets no check at install, and no warning when it disappears.

If an exposed path stops existing in the live `stat_data`, chat load warns and your plugin's light turns amber. Your resolver still runs, and has to cope with the missing node.

What each interface promises, and which ones exist today, is on [Exposes](../gamelogic_engine/exposes.md#the-interfaces).

### What an interface tells you, and what it doesn't

An interface tells you the shape: a collection (a map of id > object), one object, or one value. It never tells you whether a value is a pair or plain. ArtificKoi's `Name` is a pair and its landmarks' `Label` is plain, and the next game may do it the other way round.

So unwrap every value you read: `Array.isArray(v) ? v[0] : v`. A pair gives you its first item, and a plain value comes back as it is.

That line is only safe on the values an interface promises: `Name`, `Label`, `summary`, `Date`, `Time` and the place id. They're all single values, so an array there can only be a pair. Anywhere else, an array can be a real list, like `["Baking", "Gardening"]`, and the line would keep only `"Baking"`. So for any field beyond what an interface promises, you need the game's own docs, and an `engine.name` check around the code that reads it.

**When you walk a collection, skip MVU's own keys.** An MVU card can keep its bookkeeping inside a collection: `$meta`, `$internal`, `$key` or `template`. They aren't entries. Skip every key that starts with `$`, and `template`, and anything that isn't an object:

```js
const ids = Object.keys(cast).filter((k) => !k.startsWith('$') && k !== 'template'
  && cast[k] && typeof cast[k] === 'object');
```

It's like a class register with the teacher's notes page at the front. Count the notes page, and you have one student too many.

## Example: a cast journal that runs anywhere

```js
module.exports = {
  resolveRelay({ snapshot, exposes, engine, ownPointer }) {
    const log = [];

    // WHERE is the cast? Ask by interface. There's no game word in this file.
    const castPath = exposes['cast@1'];
    if (!castPath) {
      // the path you owe the player for declaring optionalUses
      log.push('cast@1 not exposed by this game, recording only the mode');
      return { patches: [{ op: 'add', path: ownPointer + '/Mode', value: 'degraded' }], log };
    }

    // The game named the path. You walk it.
    const cast = castPath.split('.')
      .reduce((node, seg) => (node && typeof node === 'object') ? node[seg] : undefined, snapshot);
    if (!cast || typeof cast !== 'object') {
      // Declared but missing is a real state: a fresh card, or a root the game creates later.
      // Handle it. Never throw, a throw drops all your patches.
      log.push('cast@1 -> ' + castPath + ' missing from stat_data this reply');
      return { patches: [{ op: 'add', path: ownPointer + '/Mode', value: 'awaiting-cast' }], log };
    }

    // a collection can hold MVU's own keys ($meta, template…). They aren't cast members
    const ids = Object.keys(cast).filter((k) => !k.startsWith('$') && k !== 'template'
      && cast[k] && typeof cast[k] === 'object');
    const unwrap = (v) => (Array.isArray(v) ? v[0] : v);     // MVU's [value, "label"] pair: take the value
    const firstName = ids.length ? unwrap(cast[ids[0]].Name) : '';

    const patches = [
      { op: 'add', path: ownPointer + '/Mode',      value: 'live' },
      { op: 'add', path: ownPointer + '/CastCount', value: ids.length },
      { op: 'add', path: ownPointer + '/FirstName', value: firstName },
    ];

    // WHICH game is this? Anything game-specific only behind a name the engine declared itself.
    if (engine.name === 'School') {
      patches.push({ op: 'add', path: ownPointer + '/Note',
                     value: 'School cast journal (engine ' + (engine.version || '?') + ')' });
    } else {
      log.push('engine "' + (engine.name || 'unnamed') + '": generic journal, nothing game-specific');
    }

    return { patches, log };
  },
};
```

Both questions asked, no game word outside the named branch, and every "not available" case answered with a written path instead of a crash.

## The same 2 questions from an entry

```ejs
<%_
let _jrCastLine = '';
try {
    const helper   = globalThis.MvuHelper || {};
    const engine   = (helper.engineInfo && helper.engineInfo()) || {};
    const exposes  = (helper.exposes && helper.exposes()) || {};
    const castPath = exposes['cast@1'];
    if (engine.name === 'School' && castPath) _jrCastLine = 'The cast register is at ' + castPath + '. Follow this game\'s own write rules when you change it.';
    else if (castPath) _jrCastLine = 'Cast records live at ' + castPath + '. Describe any change in prose, and let the game record it.';
} catch (e) {}
_%>
<%= _jrCastLine %>
```

On a game with no cast interface, the entry prints nothing and costs zero tokens. You have nothing true to say.

## A card with no game

A plugin with no `requires` can land on a card with no GameLogic Pack at all. That's not a mode you switch on. The same folder installs on both kinds of card, unchanged. And when a game arrives later, the next chat load simply finds more.

| What you reach for | Card WITH a GameLogic Pack | Card with NONE |
| --- | --- | --- |
| `ctx.engine` | the game engine's identity | every field **`null`**. Your generic branch runs |
| `ctx.exposes` | your declarations, matched: `{"cast@1": "Classmate"}` | **`{}`**. Every `optionalUses` runs without |
| `requires` | matched at install | **refused**. That's why a standalone plugin declares none |
| `globalThis.LogicEngine` | there | **not there**. The Worker still runs YOUR engine |
| prompt windows | narrate, PRE, POST | all 3. Extra LLM Calls are the player's, not the game's |
| `MvuHelper.rollPool` in an entry | the dealer | the same dealer |
| when `resolveRelay` runs | once per reply: after POST's block and the game's relay, or after the reply when POST writes nothing | once per reply: after POST's block, or after the reply when POST writes nothing |
| what judges your writes | the game's Zod schema. Yours is skipped | **your own schema**, written at install |
| a panel slot | yes | yes |

**Your panel binds YOUR drawer.** An interface path is the portable way to read a game. On a card with no game, it shows the "missing" marker. Honest, but useless as the only thing in your slot.

**One window.** A plugin written for any card keeps to one model window. Narrate is free, it rides on the main model. POST is a cheap model that records what the prose did. Either way, your plugin's cost lands on players who never chose your genre, so keep it to one.

Before you ship a standalone plugin:

- [ ] `engine.name === null` and an empty `exposes` both have a written branch that returns, never throws.
- [ ] No `requires`. Or you meant to write a game-bound plugin.
- [ ] Your entry deals the dice from `MvuHelper.rollPool` under your own pool name. The resolver only checks them.
- [ ] Every op uses the write shapes that land on both kinds of card. See [Write shapes that land on both](writing.md#write-shapes-that-land-on-both).
- [ ] The result is saved in your own drawer.
- [ ] The panel still says something useful when nothing is exposed.

## Checklist for any game

- [ ] Every game word in your resolver came out of `exposes`, or sits behind an `engine.name === '…'` check.
- [ ] `engine.name === null` is handled as "unknown game", not as an error.
- [ ] Every `optionalUses` interface has a written path that returns instead of throwing.
- [ ] "Declared but missing" is handled separately from "not declared".
- [ ] Every promised value goes through the unwrap line, pair or not. A field beyond the promise is read from the game's own docs, behind its `engine.name`.
- [ ] Every collection is walked without MVU's own keys: anything starting with `$`, and `template`.
- [ ] No macro read inside `<% %>`. Branching code uses `globalThis.MvuHelper`.
- [ ] The version is recorded, not checked. Unless you name the one change you're working around.

[Back to How a GameLogic Plugin works](technical.md) · [Back to index](../../README.md)
